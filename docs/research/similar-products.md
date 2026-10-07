# npkn: similar products (research as of 2026-10-07)

Sources: about 20 Exa calls, plus WebSearch and WebFetch. Anything marked (unverified) comes from aggregator or press text, or from my own prior knowledge, and I did not confirm it on the vendor's own page.

## 1. Closest products

**Burrow** (github.com/ronak-create/burrow). Closest on architecture.
- What it does: a voice-driven research canvas. You trigger it with the wake word "Hey Burrow". The AI searches the web, fetches papers, reads documents and creates blocks on a React Flow canvas.
- Overlap with npkn: voice yes (local Whisper by default; Groq and Deepgram optional). Live canvas yes. Web enrichment yes. Local yes (workspaces are plain folders of JSON and files). Desktop app built with Tauri for Mac, Windows and Linux. Undo is shared between user and AI.
- Model access: bring your own API key (any OpenAI-compatible endpoint, or Ollama). It does not run on a Claude Code or Codex subscription.
- Pricing and status: free, MIT licence. Repo created 2026-08-24, 6 stars. Posted on dev.to and launched on Product Hunt in Sept 2026. Very early.

**Weave** (sayweave.com). Closest on the user experience.
- What it does: "Think out loud and watch it become a living map." Cards appear as you speak (decisions, facts, questions, risks). Unsure ideas show as dashed cards. When you pause, it asks questions you haven't asked. Boards can be replayed, which is close to npkn's history. Also maps Meet and Teams calls.
- Overlap with npkn: the site does not mention web search, definitions, related ideas or dropping in documents. Web app, cloud-hosted. Built on Claude.
- Pricing: free tier with 15 voice minutes a month; Pro is $4.99 a month for 100 minutes.
- Status: Product Hunt launch July 2026, #15 of the day, about 117 upvotes. Solo maker.

**TalkGraph** (talkgraph.ai).
- What it does: turns speech into knowledge maps in real time, with typed cards attributed to speakers. Maps build up into a "second brain" you can query.
- Overlap with npkn: meeting and learning focus rather than solo braindumps. In the browser; mobile apps in development.
- Pricing and status: free tier. London startup, press release Aug 2026. No traction data found.

**tldraw** (tldraw.com, offline.tldraw.com, fairies.tldraw.com). The strongest incumbent on canvas plus agents.
- **tldraw offline** (16 July 2026): a free desktop app that saves to local `.tldraw` files. Claude Code, Codex and Pi can open those files, draw on the canvas and attach scripts that persist.
- This is the only product I found that explicitly uses the user's own coding agent as its AI. That is npkn's "use your subscription" idea, but there is no voice and no automatic enrichment.
- Earlier work: Make Real (2023), tldraw computer (2024, built with Google) and the Fairies multi-agent experiment.
- Pricing and traction: offline is free; the SDK is commercially licensed. Large developer following.

**Flowith** (flowith.io).
- What it does: a canvas where every prompt and answer becomes a node you can branch from. Agent Neo runs long autonomous tasks. Access to 40+ models.
- Overlap with npkn: text only, cloud, no voice.
- Pricing: free tier, then $19.90, $49.90 and $499.90 a month.
- Traction: reported 1M+ users by mid-2025 (aggregator figure, unverified).

**Ponder** (ponder.ing).
- What it does: calls itself an "Integrated Research Environment". Turns PDFs, web pages and videos into connected mind maps with an AI agent.
- Overlap with npkn: no voice, cloud.
- Pricing: credit-based. Free tier, then $14 to $42 a month billed yearly.

**Heptabase** (heptabase.com).
- What it does: visual knowledge base of cards on whiteboards. AI chat across your notes and link suggestions.
- Overlap with npkn: no voice-first capture and no live enrichment while you talk. Cloud sync.
- Pricing: $8.99, $17.99 and $53.99 a month billed yearly; higher tiers mostly buy more AI credits. 7-day trial, no free tier.
- Status: YC W22, well established among PKM users.

**Spine Canvas** (getspine.ai).
- What it does: a canvas of blocks (chat, deep research, memo, image, slides) with branching. One subscription covers 300+ models.
- Overlap with npkn: matches the output side (research, slides, images) but not voice capture. Cloud.
- Status: YC launch Oct 2025. Free tier.

## 2. Others worth knowing

- **Shimmer** (shimmerdiagrams.com): listens to meetings and draws Mermaid diagrams live. Transcription and the LLM run in the browser (WebGPU).
- **Miro Sidekicks / Flows** (Canvas 26): agents that plan, then build docs, diagrams and kanbans on the board. Connectors to Slack, GitHub and Granola. Enterprise, cloud.
- **FigJam AI / Whimsical AI / Confluence and Microsoft Whiteboard Copilot**: generate a board from a prompt (my own knowledge, not re-checked).
- **Figma Weave** (formerly Weavy), **Krea Nodes**, **Magnific Spaces**, **Mobbi Canvas**, **ComfyUI**, **nodetool** (open source): node-based canvases for generating images, video and 3D.
- **Claude Design** (Anthropic Labs, Apr 2026): chat plus a live canvas that produces prototypes, slides and one-pagers; exports PPTX, PDF and HTML. It is about design, not thinking.
- **Kosmik**: infinite canvas with a built-in browser and PDF viewer, plus AI auto-tagging. Freemium.
- **Recall** (recall.it): saves and summarises content into an auto-linked knowledge graph. Graph View 2.0 (Jan 2026) has a timeline animation.
- **Napkin.one**: AI note app that surfaces related ideas. Shut its desktop prototype 30 June 2026; now iPhone only.
- **Napkin AI** (napkin.ai): turns text into diagrams and infographics. $10M seed (Accel, CRV); reported 5M+ users (unverified).
- **dim0** (github vcmf/dim0, 168 stars): open-source collaborative canvas with notes, mini-apps and agents.
- **yapdraw** (16 stars): "Wispr Flow for Excalidraw", for building diagrams by voice.
- **Treyspace**: Excalidraw canvas with graph-aware retrieval; MIT SDK. Tiny launch.
- **Obsidian**: Canvas plugins (Augmented Canvas, Canvas Conversation, Ask Canvas) and claude-obsidian (Claude Code builds a linked vault).
- **VoiceMap**, **Sythio**, **Voicethoughts**, **Voticle**: mobile apps that turn voice notes into mind maps or structured notes.
- **Hackathon and repo prototypes** (all near zero stars): Stun, Synapse (multi-agent spatial brainstorming), conversation-canvas (live speech on tldraw), nodepad, thinkix.
- **Research**: "Tangible AI Mind-map" (2026): speech plus projection AR, where the LLM acts as a brainstorming partner.
- **Not checked**: Scrintal, Muse and Granola canvas output. I could not confirm their 2026 status, and I found no Granola feature that outputs to a canvas.

## 3. Open space vs crowded

**Crowded:**
- Turning text, PDFs or links into a mind map: dozens of generators, Ponder, Mapify and Napkin AI.
- Chat or prompt nodes on a canvas: Flowith, Spine, Miro and many open-source clones.
- Node canvases for generating images and video.
- Turning meetings into maps: Weave, TalkGraph, Shimmer, Miro with Granola.
- "Voice to mind map" is now a fast-growing category of small apps and hackathon projects. It is no longer novel by itself.

**Apparently open (no shipping product found that combines all of these):**
1. **Solo, live voice braindump plus proactive enrichment.** That means web results, definitions, examples, related ideas and question post-its appearing while you talk. Weave asks questions but does not search. Burrow searches when told to, not proactively.
2. **Running on the user's existing Claude Code or Codex subscription.** Only tldraw offline does this, and only for canvas editing, with no voice or enrichment. Every other product either charges for credits (Heptabase, Ponder, Flowith, Weave) or asks for API keys (Burrow).
3. **Napkins as plain folders plus time travel.** Burrow has folders, Weave has replay; nobody has both together with a full history.
4. **Pointing the app at a folder** to build a napkin from it.
5. **One space that goes from braindump to write-up, deck or media.** Spine and Claude Design cover the outputs, but neither starts from voice.

**Risks:**
- Burrow is the same idea, open source, and could add Claude Code support quickly.
- tldraw offline plus Claude Code plus a voice skill is a weekend project for power users.
- Miro and Heptabase could add live voice.

## 4. Name clash

- **Napkin AI** (napkin.ai): text to visuals, $10M seed, millions of users. The biggest clash, because it is also an AI visual-thinking tool.
- **Napkin.one** (Napkin LLC): AI idea and note app, iPhone only. Same space: idea capture with AI connections.
- **napkin.io**: "fastest way to build and deploy APIs" (developer platform; the site is still live).
- **Napkin Global / Napkin Deals** owns **npkn.com**, which redirects to napkindeals.com, a deals and finance site.
- **npkn.ai** is a parked page (redirects to `/lander`). **npkn.app** and **npkn.io** did not resolve; their availability is unverified.
- **napkin.app** is for sale on Aftermarket.
- Smaller uses:
  - App Store: "Napkin Ideas", "Napkin: Track Ideas & Projects" and "Napkin AI – Image Generator".
  - Older companies: Napkkin (networking app, 2012) and RedNapkin.
  - Trademark: a "NAPKN" US filing (serial 87473609; status not checked).
- I found no software product called "npkn" itself.
