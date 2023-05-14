import { OmitFirstArg } from '@laxels/utils';
import { Configuration, OpenAIApi } from 'openai';
import { getResponseStream, streamSingleResponse } from './stream';

export type OpenAIClient = {
  getResponseStream: OmitFirstArg<typeof getResponseStream>;
  streamSingleResponse: OmitFirstArg<typeof streamSingleResponse>;
};

export function createOpenAIClient(apiKey: string): OpenAIClient {
  const configuration = new Configuration({ apiKey });
  const api = new OpenAIApi(configuration);

  return {
    getResponseStream: getResponseStream.bind(null, api),
    streamSingleResponse: streamSingleResponse.bind(null, api)
  };
}
