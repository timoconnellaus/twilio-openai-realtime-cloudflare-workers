// Generated by Wrangler by running `wrangler types --env-interface CloudflareBindings`

interface CloudflareBindings {
	OPENAI_API_KEY: string;
	WEBSOCKET_SERVER: DurableObjectNamespace<import("./src/index").WebSocketServer>;
}
