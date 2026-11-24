# AI chat

The AI button (sparkle) in the top bar opens a floating chat window in **3D Design** and **Laser**.
Ask about the design, or describe what to make: the AI builds and changes it with the same commands
you use. Every change it makes is one undo step named "AI: …", and **Undo this reply** takes back a
whole reply. Tick **Ask before edits** to approve each change (Apply / Skip / Apply all).

## Setting up

Settings → AI:

- **Anthropic (Claude)**: paste an API key from console.anthropic.com, then **Test connection**.
  The default model is `claude-opus-5-5`; **Effort** trades speed and cost against care.
- **Local / OpenAI-compatible**: a model server such as Ollama (`http://localhost:11434/v1`) or
  LM Studio (`http://localhost:1234/v1`). Pick a model from the list. In the browser the server
  must be on the same computer; the desktop app can use one elsewhere.

## Web access

With Anthropic, **Web access** (on by default, in Settings → AI) lets the AI search the web and read
pages, for example to look up a screw size or a board's mounting holes. Anthropic runs the searches
on its side ($10 per 1,000 searches, plus the extra text read). Searches and pages read show as chips
in the reply, and cited pages are listed as Sources. If web search isn't enabled for the
organisation, an admin can turn it on in the Claude Console.

Other models (a local model, or Anthropic with Web access off) get **fetch_page** in the desktop
app: it reads a public web page as text. The desktop app fetches it and refuses anything on this
computer or the local network (including after redirects), so it can never reach a printer, laser
or router. It isn't available in the browser, which can't read other sites.

## Privacy and safety

- Each message sends a summary of the design (names, sizes, positions, the selection) and the
  results of the AI's tool calls to the provider. **Attach view** adds a picture of the view.
- Desktop: keys are encrypted with the system keychain and stay in the main process; the window
  never sees them, and an Anthropic key can only go to api.anthropic.com.
- Browser: the key is kept for the open tab only, unless you tick **Remember on this device**.
- The AI has no way to connect to, start, pause, frame, home or jog a laser or printer, or to send
  G-code, and it doesn't work in the Slicer. Locked shapes are left alone.

## Code

`src/renderer/ai/`: `tools.js` (3D tools), `lasertools.js`, `schema.js` (input checks),
`providers.js` (Anthropic and OpenAI-compatible adapters), `chat.js` (the loop), `config.js`
(settings, keys, the desktop request bridge), `window.js`, `settings.js`. Desktop side:
`electron/ai.js`. Tests: `npm run test:ai` (adapters) and `tools/smoke-ai.js` (in `npm run test:all`).
