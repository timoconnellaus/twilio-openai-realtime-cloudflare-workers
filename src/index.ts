import { Hono, HonoRequest } from "hono";
import { XMLBuilder } from "fast-xml-parser";
import { DurableObject } from "cloudflare:workers";
import { t, createTools } from "zod-to-openai-tool";
import type { OpenAI } from "openai";
import { z } from "zod";

const app = new Hono<{ Bindings: CloudflareBindings }>();

const { tools, processAssistantActions, processChatActions } = createTools({
  getMetallicaAlbums: t
    .input(
      z.object({
        limit: z.number().optional().default(10),
      }),
    )
    .describe("Get Metallica albums")
    .run(async ({ limit }) => {
      console.log(`Fetching up to ${limit} Metallica albums`);

      const metallicaAlbums = {
        albums: [
          {
            name: "Kill 'Em All",
            releaseYear: 1983,
          },
          {
            name: "Ride the Lightning",
            releaseYear: 1984,
          },
          {
            name: "Master of Puppets",
            releaseYear: 1986,
          },
          {
            name: "...And Justice for All",
            releaseYear: 1988,
          },
          {
            name: "Metallica (The Black Album)",
            releaseYear: 1991,
          },
          {
            name: "Load",
            releaseYear: 1996,
          },
          {
            name: "Reload",
            releaseYear: 1997,
          },
          {
            name: "St. Anger",
            releaseYear: 2003,
          },
          {
            name: "Death Magnetic",
            releaseYear: 2008,
          },
          {
            name: "Hardwired... to Self-Destruct",
            releaseYear: 2016,
          },
        ].slice(0, limit),
      };

      return metallicaAlbums;
    }),
});

const toolsWithoutType = tools.map((t) => ({
  ...t.function,
  type: "function",
}));

// Constants
const SYSTEM_MESSAGE =
  "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
const VOICE = "alloy";

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

app.get("/", (c) =>
  c.json({ message: "Twilio Media Stream Server is running!" }),
);

// Route for Twilio to handle incoming and outgoing calls
app.all("/incoming-call", (c) => {
  const xmlBuilder = new XMLBuilder({ format: true });

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Connect>
                                    <Stream url="wss://${c.req.header("host")}/media-stream" />
                                </Connect>
                            </Response>`;

  return c.text(twimlResponse, 200, {
    "Content-Type": "text/xml",
  });
});

app.all("/media-stream", (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return c.text("Durable Object expected Upgrade: websocket", {
      status: 426,
    });
  }

  let id = c.env.WEBSOCKET_SERVER.newUniqueId();
  let stub = c.env.WEBSOCKET_SERVER.get(id);

  return stub.fetch(c.req.raw);
});

export class WebSocketServer extends DurableObject {
  private _OPENAI_API_KEY: string;
  currentlyConnectedWebSockets: number;
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    this._OPENAI_API_KEY = env.OPENAI_API_KEY;
    this.currentlyConnectedWebSockets = 0;
  }

  async fetch(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    this.currentlyConnectedWebSockets += 1;

    async function connectToOpenAi(apiKey: string) {
      let response = await fetch(
        "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
        {
          method: "POST",
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
        },
      );

      if (response.status !== 101) {
        throw new Error(
          `Failed to connect to OpenAI WebSocket: ${response.statusText}`,
        );
      }

      let { webSocket: targetSocket } = response;

      if (!targetSocket) throw new Error("No websocket");
      return targetSocket;
    }

    const openAiWs = await connectToOpenAi(this._OPENAI_API_KEY);
    openAiWs.accept();

    let streamSid: string | null = null;

    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          tools: toolsWithoutType,
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const responseCreate = (instructions: string) => {
      const sessionUpdate = {
        type: "response.create",
        response: {
          tools: toolsWithoutType,
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: instructions,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.addEventListener("open", (event) => {
      console.log(event);
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
    });

    openAiWs.addEventListener("message", async (event) => {
      try {
        const response = JSON.parse(event.data.toString());

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === "session.created") {
          sendSessionUpdate(),
            responseCreate(
              `Say: "Hi. How can I help you?" using an English accent`,
            );
        }

        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }

        if (response.type === "response.function_call_arguments.done") {
          const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
          toolCalls.push({
            function: {
              arguments: response.arguments,
              name: response.name,
            },
            id: response.call_id,
            type: "function",
          });

          const result = await processChatActions(toolCalls);

          openAiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              previous_item_id: response.item_id,
              item: {
                call_id: response.call_id,
                type: "function_call_output",
                output: JSON.stringify(result[0]),
              },
            }),
          );

          responseCreate("Respond to the user");
        }

        if (response.type === "response.audio.delta" && response.delta) {
          // const deltaConverted = base64Pcm16ToG711Ulaw(response.delta);

          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: response.delta,
            },
          };

          console.log("AudioDelta", audioDelta);

          server.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          event.data,
        );
      }
    });

    openAiWs.addEventListener("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.addEventListener("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });

    server.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data.toString());

        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };

              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            console.log("START", data);
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", event);
      }
    });

    server.addEventListener("close", (cls: CloseEvent) => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, "Ended");
      console.log("Client disconnected.");
      this.currentlyConnectedWebSockets -= 1;
      server.close(1000, "Durable Object is closing WebSocket");
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}

export default app;
