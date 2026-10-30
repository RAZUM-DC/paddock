// Чатовые модели ключа NeuralDeep (GET /v1/models через egress). Ключ приходит из браузера (он лежит в config.toml
// codex этого пользователя) и нигде в морде не сохраняется.
import { sessionFromHeaders } from "@/lib/auth";
import { viaEgress } from "@/lib/proxy";

export const dynamic = "force-dynamic";

// Всё, что не чат: эмбеддинги, реранк, речь, картинки, музыка, классификаторы.
const notChat = /embed|^e5-|bge|frida|rerank|whisper|gigaam|tts|diariz|lyria|decision|clef|image|upscale|background|enhance|avatar|speech|ocr|search|music|^audio/i;

export async function POST(req: Request) {
  const session = await sessionFromHeaders(req.headers);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (req.headers.get("origin") !== process.env.PUBLIC_URL) return Response.json({ error: "bad origin" }, { status: 403 });

  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  if (!key || !/^sk-[\w-]{10,}$/.test(key)) return Response.json({ error: "нужен ключ вида sk-…" }, { status: 400 });
  try {
    const r = await viaEgress("api.neuraldeep.ru", "/v1/models", { Authorization: `Bearer ${key}` });
    const j = JSON.parse(r.body || "{}");
    if (r.status !== 200) return Response.json({ error: j.error?.message ?? j.detail ?? `NeuralDeep ответил ${r.status}` }, { status: 502 });
    const models = (j.data ?? [])
      .filter((m: any) => {
        const kind = String(m.type ?? m.mode ?? m.model_type ?? "").toLowerCase();
        if (kind) return kind === "chat" || kind === "llm" || kind === "completion";
        return !notChat.test(m.id);
      })
      .map((m: any) => ({
        id: m.id as string,
        context: (m.limit?.context ?? m.context_length ?? m.context_window ?? null) as number | null,
        reasoning: !/noreason/.test(m.id) && (m.capabilities?.reasoning ?? m.supports_reasoning ?? true) !== false,
      }));
    return Response.json({ models });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
