import { promises as fs } from 'fs'
import * as path from 'path'
import { BigNumber, Contract, Signer } from 'ethers'
import { sleep } from '@eth-optimism/core-utils'
import {
  BaseServiceV2,
  StandardOptions,
  ExpressRouter,
  validators,
  Gauge,
  Counter,
} from '@eth-optimism/common-ts'
import {
  CrossChainMessenger,
  StandardBridgeAdapter,
  DeepPartial,
  DEFAULT_L2_CONTRACT_ADDRESSES,
  MessageStatus,
  OEContractsLike,
  CrossChainMessage,
  MessageDirection,
} from '@eth-optimism/sdk'
import { Provider } from '@ethersproject/abstract-provider'
import { version } from '../package.json'
import { Multicaller, CallWithHeight } from './multicaller'

type MessageRelayerOptions = {
  l1RpcProvider: Provider
  l2RpcProvider: Provider
  l1Wallet: Signer
  fromL2TransactionIndex?: number
  addressManager?: string
  multicall?: string
  multicallTargetGas?: number
  l1CrossDomainMessenger?: string
  l1StandardBridge?: string
  l2StandardBridge?: string
  stateCommitmentChain?: string
  canonicalTransactionChain?: string
  bondManager?: string
  maxBlockBatchSize?: number
  pollInterval?: number
  receiptTimeout?: number
  gasMultiplier?: number
  depositConfirmationBlocks?: number
  l1BlockTimeSeconds?: number
  stateFilePath?: string
}

type MessageRelayerMetrics = {
  highestCheckedL2: Gauge
  highestKnownL2: Gauge
  numRelayedMessages: Counter
}

type MessageRelayerState = {
  wallet: Signer
  messenger: CrossChainMessenger
  multicaller?: Multicaller
  highestCheckedL2: number
  highestKnownL2: number
}

export class MessageRelayerService extends BaseServiceV2<
  MessageRelayerOptions,
  MessageRelayerMetrics,
  MessageRelayerState
> {
  constructor(options?: Partial<MessageRelayerOptions & StandardOptions>) {
    super({
      name: 'Message_Relayer',
      version,
      options,
      optionsSpec: {
        l1RpcProvider: {
          validator: validators.provider,
          desc: 'Provider for interacting with L1.',
        },
        l2RpcProvider: {
          validator: validators.provider,
          desc: 'Provider for interacting with L2.',
        },
        l1Wallet: {
          validator: validators.wallet,
          desc: 'Wallet used to interact with L1.',
        },
        fromL2TransactionIndex: {
          validator: validators.num,
          desc: 'Index of the first L2 transaction to start processing from.',
          default: 0,
        },
        addressManager: {
          validator: validators.str,
          desc: 'Address of the Lib_AddressManager on Layer1.',
        },
        multicall: {
          validator: validators.str,
          desc: 'Address of the multicall2 on Layer1.',
        },
        multicallTargetGas: {
          validator: validators.num,
          desc: 'gas target for multicall contract when the relay',
          default: 1500000,
        },
        l1CrossDomainMessenger: {
          validator: validators.str,
          desc: 'Address of the Proxy__OVM_L1CrossDomainMessenger on Layer1.',
        },
        l1StandardBridge: {
          validator: validators.str,
          desc: 'Address of the Proxy__OVM_L1StandardBridge on Layer1.',
        },
        l2StandardBridge: {
          validator: validators.str,
          desc: 'Address of the L2StandardBridge on Layer2.',
        },
        stateCommitmentChain: {
          validator: validators.str,
          desc: 'Address of the StateCommitmentChain on Layer1.',
        },
        canonicalTransactionChain: {
          validator: validators.str,
          desc: 'Address of the CanonicalTransactionChain on Layer1.',
        },
        bondManager: {
          validator: validators.str,
          desc: 'Address of the BondManager on Layer1.',
        },
        maxBlockBatchSize: {
          validator: validators.num,
          desc: 'If using multicall, max block batch size for multicall messaging relay.',
          default: 200,
        },
        pollInterval: {
          validator: validators.num,
          desc: 'Polling interval of StateCommitmentChain (unit: msec).',
          default: 1000,
        },
        receiptTimeout: {
          validator: validators.num,
          desc: 'Receipt wait timeout for relay transaction (unit: msec).',
          default: 15000,
        },
        gasMultiplier: {
          validator: validators.num,
          desc: 'Gas limit multiplier.',
          default: 1.1,
        },
        depositConfirmationBlocks: {
          validator: validators.num,
          desc: 'Blocks before a deposit is confirmed',
          default: 2,
        },
        l1BlockTimeSeconds: {
          validator: validators.num,
          desc: 'Block time in seconds for the L1 chain.',
          default: 15,
        },
        stateFilePath: {
          validator: validators.str,
          desc: 'the file of state file whitch holds the last state',
          default: '~/.message-relayer/state.json',
        },
      },
      metricsSpec: {
        highestCheckedL2: {
          type: Gauge,
          desc: 'Highest L2 tx that has been checked',
        },
        highestKnownL2: {
          type: Gauge,
          desc: 'Highest known L2 height',
        },
        numRelayedMessages: {
          type: Counter,
          desc: 'Number of messages relayed by the service',
        },
      },
    })
  }

  protected async init(): Promise<void> {
    this.state.wallet = this.options.l1Wallet.connect(
      this.options.l1RpcProvider
    )

    const l1ContractOpts = [
      this.options.addressManager,
      this.options.l1CrossDomainMessenger,
      this.options.l1StandardBridge,
      this.options.stateCommitmentChain,
      this.options.canonicalTransactionChain,
      this.options.bondManager,
    ]

    let contracts: DeepPartial<OEContractsLike> = undefined
    if (l1ContractOpts.every((x) => x)) {
      contracts = {
        l1: {
          AddressManager: this.options.addressManager,
          L1CrossDomainMessenger: this.options.l1CrossDomainMessenger,
          L1StandardBridge: this.options.l1StandardBridge,
          StateCommitmentChain: this.options.stateCommitmentChain,
          CanonicalTransactionChain: this.options.canonicalTransactionChain,
          BondManager: this.options.bondManager,
        },
        l2: DEFAULT_L2_CONTRACT_ADDRESSES,
      }
    } else if (l1ContractOpts.some((x) => x)) {
      throw new Error('L1 contract address is missing.')
    }

    const l1Network = await this.state.wallet.provider.getNetwork()
    const l1ChainId = l1Network.chainId
    const l2Network = await this.options.l2RpcProvider.getNetwork()
    const l2ChainId = l2Network.chainId
    this.state.messenger = new CrossChainMessenger({
      l1SignerOrProvider: this.state.wallet,
      l2SignerOrProvider: this.options.l2RpcProvider,
      l1ChainId,
      l2ChainId,
      depositConfirmationBlocks: this.options.depositConfirmationBlocks,
      l1BlockTimeSeconds: this.options.l1BlockTimeSeconds,
      // TODO: bridges:
      bridges: {
        Standard: {
          Adapter: StandardBridgeAdapter,
          l1Bridge: this.options.l1StandardBridge,
          l2Bridge: this.options.l2StandardBridge,
        },
      },
      contracts,
      bedrock: true,
    })

    this.state.multicaller = new Multicaller(
      this.options.multicall,
      this.state.wallet,
      this.options.multicallTargetGas,
      this.options.gasMultiplier
    )

    const lastState = await this.readStateFromFile()
    this.state.highestCheckedL2 =
      this.options.fromL2TransactionIndex || lastState.highestCheckedL2
    this.state.highestKnownL2 =
      await this.state.messenger.l2Provider.getBlockNumber()
  }

  async routes(router: ExpressRouter): Promise<void> {
    router.get('/status', async (req: any, res: any) => {
      return res.status(200).json({
        highestCheckedL2: this.state.highestCheckedL2,
        highestKnownL2: this.state.highestKnownL2,
      })
    })
  }

  protected async main(): Promise<void> {
    await this.handleMultipleBlock()
  }

  // override to write the last state
  public async stop(): Promise<void> {
    await this.writeStateToFile(this.state)
    await super.stop()
  }

  protected async handleMultipleBlock(): Promise<void> {
    // Update metrics
    this.metrics.highestCheckedL2.set(this.state.highestCheckedL2)
    this.metrics.highestKnownL2.set(this.state.highestKnownL2)
    this.logger.debug(`highestCheckedL2: ${this.state.highestCheckedL2}`)
    this.logger.debug(`highestKnownL2: ${this.state.highestKnownL2}`)

    // If we're already at the tip, then update the latest tip and loop again.
    if (this.state.highestCheckedL2 > this.state.highestKnownL2) {
      this.state.highestKnownL2 =
        await this.state.messenger.l2Provider.getBlockNumber()

      // Sleeping for 1000ms is good enough since this is meant for development and not for live
      // networks where we might want to restrict the number of requests per second.
      await sleep(1000)
      this.logger.debug(`highestCheckedL2 > this.state.highestKnownL2`)
      return
    }

    let calldatas: CallWithHeight[] = []
    const target = this.state.messenger.contracts.l1.OptimismPortal.target
    const callback = (hash: string, calls: CallWithHeight[]) => {
      this.logger.info(`relayer sent multicall: ${hash}`)
      this.updateHighestCheckedL2(calls)
      this.metrics.numRelayedMessages.inc(calls.length)
    }

    for (
      let i = this.state.highestCheckedL2;
      i < this.state.highestCheckedL2 + this.options.maxBlockBatchSize;
      i++
    ) {
      const block =
        await this.state.messenger.l2Provider.getBlockWithTransactions(i)
      if (block === null) {
        break
      }

      // empty block is allowed
      if (block.transactions.length === 0) {
        continue
      }

      for (let j = 0; j < block.transactions.length; j++) {
        const txHash = block.transactions[j].hash
        const status = await this.state.messenger.getMessageStatus(txHash)
        this.logger.debug(
          `txHash: ${txHash}, status: ${MessageStatus[status]})`
        )

        if (status !== MessageStatus.READY_TO_PROVE) {
          continue
        }

        // Estimate gas cost for proveMessage
        if (this.state.multicaller?.singleCallGas === 0) {
          const estimatedGas = (
            await this.state.messenger.estimateGas.proveMessage(txHash)
          ).toNumber()
          this.state.multicaller.singleCallGas = estimatedGas
        }

        // Populate calldata, the append to the list
        const callData = (
          await this.state.messenger.populateTransaction.proveMessage(txHash)
        ).data
        calldatas.push({ target, callData, blockHeight: block.number })

        // go next when lower than multicall target gas
        if (!this.state.multicaller?.isOvertargetGas(calldatas.length)) {
          continue
        }

        // send multicall, then update the checked L2 height
        // return the remaining callcatas, those are failed due to gas limit
        calldatas = await this.state.multicaller?.multicall(calldatas, callback)
      }
    }

    // flush the left calldata
    if (0 < calldatas.length)
      await this.state.multicaller?.multicall(calldatas, callback)
  }

  protected updateHighestCheckedL2(calldatas: CallWithHeight[]): void {
    // assume the last element is the hightst, so doen't traverse all the element
    const highest = calldatas[calldatas.length - 1].blockHeight
    // const highest = calldatas.reduce((maxCall, currentCall) => {
    //   if (!maxCall || currentCall.blockHeight > maxCall.blockHeight) {
    //     return currentCall;
    //   }
    //   return maxCall;
    // }).blockHeight
    this.state.highestCheckedL2 = highest
    this.logger.info(`updated highest checked L2: ${highest}`)
  }

  protected async readStateFromFile(): Promise<
    Pick<MessageRelayerState, 'highestCheckedL2' | 'highestKnownL2'>
  > {
    try {
      const data = await fs.readFile(this.options.stateFilePath, 'utf-8')
      const json = JSON.parse(data)
      return {
        highestCheckedL2: json.highestCheckedL2,
        highestKnownL2: json.highestKnownL2,
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // return nothing, if state file not found
        return { highestCheckedL2: 0, highestKnownL2: 0 }
      }
      throw new Error(
        `failed to read state file: ${this.options.stateFilePath}, err: ${err.message}`
      )
    }
  }

  protected async writeStateToFile(
    state: Pick<MessageRelayerState, 'highestCheckedL2' | 'highestKnownL2'>
  ): Promise<void> {
    const dir = path.dirname(this.options.stateFilePath)

    try {
      await fs.access(dir)
    } catch (error) {
      // create dir if not exists
      await fs.mkdir(dir, { recursive: true })
    }

    const data = JSON.stringify(state, null, 2)
    await fs.writeFile(this.options.stateFilePath, data, 'utf-8')
  }
}

if (require.main === module) {
  const service = new MessageRelayerService()
  service.run()
}
