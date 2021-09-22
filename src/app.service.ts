import { Context } from 'koa';
import { redisGetJson, redisSetJson } from './clients/redis';
import { LoggerService } from './helpers';
import { ChannelResult } from './interfaces/channel-result';
import { CustomerCreditTransferInitiation } from './interfaces/iPain001Transaction';
import { Channel, NetworkMap } from './interfaces/network-map';
import { RuleResult } from './interfaces/rule-result';
import { TypologyResult } from './interfaces/typology-result';
import apm from 'elastic-apm-node';

export const handleChannels = async (
  ctx: Context,
  transaction: CustomerCreditTransferInitiation,
  networkMap: NetworkMap,
  ruleResult: RuleResult[],
  typologyResult: TypologyResult,
  channelResult: ChannelResult,
  channel: Channel,
): Promise<{
  transactionID: string;
  message: string;
}> => {
  try {
    const transactionID =
      transaction.PaymentInformation.CreditTransferTransactionInformation
        .PaymentIdentification.EndToEndIdentification;

    // Initialize the result message
    const result = {
      transactionID: transactionID,
      message: '',
    };

    // Check if the channel is completed
    const hasChannelCompleted = await checkChannelCompletion(
      transactionID,
      channel,
      typologyResult,
    );

    // If the channel is completed, then save the transaction evaluation result
    if (hasChannelCompleted) {
      const transactionHistoryQuery = `
      INSERT {
        "transactionID": ${JSON.stringify(transactionID)},
        "transaction": ${JSON.stringify(transaction)},
        "networkMap": ${JSON.stringify(networkMap)},
        "ruleResult": ${JSON.stringify(ruleResult)},
        "typologyResult": ${JSON.stringify(typologyResult)},
        "channelResult": ${JSON.stringify(channelResult)}
    } INTO "history"
    `;

      await ctx.state.arangodb.query(transactionHistoryQuery);

      result.message = 'The transaction evaluation result is saved.';
    }
    result.message = 'The transaction evaluation result is not saved.';

    return result;
  } catch (error) {
    LoggerService.error(error as string);
    throw error;
  }
};

const checkChannelCompletion = async (
  transactionID: string,
  channel: Channel,
  typologyResult: TypologyResult,
): Promise<boolean> => {
  const cacheKey = `${transactionID}_${channel.channel_id}`;
  const cacheData = await redisGetJson(cacheKey);

  const cacheResults: TypologyResult[] = [...JSON.parse(cacheData)];

  // First check: The channel is not completed
  if (cacheResults.some((t) => t.typology === typologyResult.typology)) {
    return false;
  }

  cacheResults.push({
    typology: typologyResult.typology,
    result: typologyResult.result,
  });

  // Second check: if all results for this Channel is found
  if (cacheResults.length < channel.typologies.length) {
    LoggerService.log(
      `[${transactionID}] Save Channel interim rule results to Cache`,
    );

    await redisSetJson(cacheKey, JSON.stringify(cacheResults));

    return false;
  }
  // The channel is completed
  return true;
};
