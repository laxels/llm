import type {
  ChatCompletionRequestMessage,
  ChatCompletionResponseMessageRoleEnum,
  CreateChatCompletionRequest,
  OpenAIApi
} from 'openai';
import { Readable, Transform, type TransformCallback } from 'stream';
import { withExponentialBackoff } from './request';
import { isAxiosError } from 'axios';

export type StreamData = {
  data: string;
  finished: boolean;
};

const JSON_LINE_SEPARATOR = `___BASILISK_JSON_LINE_SEPARATOR___`;
const DEFAULT_MODEL = `gpt-4-1106-preview`;
const DEFAULT_OPENAI_API_TIMEOUT = 2000;

export async function getResponseStream(
  api: OpenAIApi,
  messages: ChatCompletionRequestMessage[]
): Promise<ReadableStream> {
  const apiResponse = await getAPIStream(api, { model: DEFAULT_MODEL, messages });
  if (apiResponse == null) {
    throw new Error(`Error getting response from OpenAI`);
  }

  const modifyChunkStream = new ModifyChunkStream(modifyChunk);
  return apiResponse.pipe(modifyChunkStream) as unknown as ReadableStream;
}

export async function streamSingleResponse(
  api: OpenAIApi,
  messages: ChatCompletionRequestMessage[]
): Promise<string> {
  const responseStream = await getResponseStream(api, messages);
  const response = await streamChatResponse({
    responseStream: responseStream as unknown as Readable
  });
  return response;
}

type StreamHandlers = {
  onData?: (data: string) => void;
  onEnd?: () => void;
  onError?: () => void;
};

type StreamResponseParams = {
  responseStream: Readable;
} & StreamHandlers;

async function streamChatResponse({
  responseStream,
  onData,
  onEnd
}: StreamResponseParams): Promise<string> {
  let responseStr = ``;

  for await (const chunk of responseStream) {
    const jsonLines = (chunk as Buffer).toString();

    for (const json of jsonLines.split(JSON_LINE_SEPARATOR).filter((l) => l)) {
      const { data, finished } = JSON.parse(json) as StreamData;

      onData?.(data);
      responseStr += data;

      if (finished) {
        onEnd?.();
        return responseStr;
      }
    }
  }

  return responseStr;
}

type GetAPIStreamParams = {
  model: CreateChatCompletionRequest[`model`];
  messages: ChatCompletionRequestMessage[];
};

async function getAPIStream(
  api: OpenAIApi,
  { model, messages }: GetAPIStreamParams
): Promise<Readable | null> {
  try {
    return await withExponentialBackoff(async () => {
      const { data: apiResponse } = await api.createChatCompletion(
        {
          model,
          messages,
          n: 1,
          temperature: 1,
          stream: true
        },
        {
          responseType: `stream`,
          timeout: DEFAULT_OPENAI_API_TIMEOUT
        }
      );

      return apiResponse as unknown as Readable;
    });
  } catch (err) {
    if (isAxiosError(err)) {
      console.error(`Error generating response: ${err.response?.data?.error?.message ?? err}`);
    } else {
      console.error(err);
    }
    return null;
  }
}

type TransformFunction = (chunk: Buffer) => Buffer;

// Custom transform stream
class ModifyChunkStream extends Transform {
  modifyFunction: TransformFunction;

  constructor(modifyFunction: TransformFunction) {
    super();
    this.modifyFunction = modifyFunction;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    // Apply the modification function to the chunk
    const modifiedChunk = this.modifyFunction(chunk);

    // Push the modified chunk to the next stream
    this.push(modifiedChunk);

    // Signal that the transformation is complete
    callback();
  }
}

const DATA_CHUNK_HEADER = `data: `;
const DATA_CHUNK_TERMINATOR = `[DONE]`;
const STOP_FINISH_REASON = `stop`;

type ChunkData = {
  choices: Array<{ delta: MessageDelta; finish_reason: string }>;
};

type MessageDelta = {
  role?: ChatCompletionResponseMessageRoleEnum;
  content?: string;
};

function modifyChunk(chunk: Buffer): Buffer {
  const tokens: string[] = [];
  let finished = false;

  const dataStrs = chunk
    .toString()
    .trim()
    .split(`\n`)
    .map((l) => l.trim());

  for (const dataStr of dataStrs) {
    if (!dataStr.startsWith(DATA_CHUNK_HEADER)) {
      continue;
    }
    const data = dataStr.slice(DATA_CHUNK_HEADER.length);
    if (data === DATA_CHUNK_TERMINATOR) {
      break;
    }
    try {
      const { choices } = JSON.parse(data) as ChunkData;
      if (choices.length === 0) {
        throw new Error(`No choices returned from API`);
      }
      const {
        delta: { content },
        finish_reason
      } = choices[0];
      if (content) {
        tokens.push(content);
      }
      if (finish_reason === STOP_FINISH_REASON) {
        finished = true;
      }
    } catch (err) {
      console.error(err);
    }
  }

  const streamData: StreamData = { data: tokens.join(``), finished };
  return Buffer.from(`${JSON.stringify(streamData)}${JSON_LINE_SEPARATOR}`);
}
