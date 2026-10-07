# Search bake-off: built-in WebSearch/WebFetch vs Exa (with Firecrawl /search spot-check)

Run on 2026-10-07. Exa: 11 calls, about $0.07 in total ($0.007 per search with 1500-char text and highlights, $0.004 per findSimilar, $0.005 per /answer). Firecrawl /search: 2 calls, 2 credits each. Built-in: 7 WebSearch calls and 1 WebFetch call. Exa latency was measured (0.3–4.9 s). Built-in latency was not timed: standard mode took a few seconds per call, extended mode noticeably longer.

**Content depth applies to every task.** Built-in WebSearch returns titles, URLs and a summary written by a model. It returns no page text, so going deeper takes one WebFetch per page, and WebFetch is also summarised by a small model. Exa returns up to N characters of clean page text, plus highlights, for all 10 results in a single call. Firecrawl /search returns snippets (it can scrape too, at extra cost).

## Task 1: Competitors for a voice-first AI brainstorming canvas

| | Built-in (2 searches; the second in extended mode) | Exa (2 searches: auto, and category=company) |
|---|---|---|
| Relevance | ~7/15 on target. Several hits were hackathon pages, SDK pages or listicles | ~17/20 on target. Nearly all are real product homepages |
| Novelty | VoiceMap, Ayoa, illumi, Curiso, BloxGPT, Google Product Canvas | Vosa, BUD, Overscope, Yapwise, Noeji, MindFlow, Nebula, Loominote, Vnote, Weave, Jeda.ai, CanvasGPT, flowspot |
| Depth | Summary only | 1500 chars of homepage text for each result |
| Calls | 2, and still thin | 1 was enough. The second added a different long tail |

**Example lists.** Exa (auto): vosaapp.com, budcanvas.app, neurokitai.com/weave, canvasgpt.com, overscope.app, mind-flow.ai, yapwise.xyz, noeji.com. Built-in, first pass: devfolio.co/projects/mindify, videosdk.live/ai-apps/curiso, labs.google product-canvas, producthunt magican, a geeky-gadgets listicle. Firecrawl: fabric.so, storyflow.so, talknotes.io, ideamap.ai, Brainstory, plus YouTube, Facebook and Reddit noise.

**Winner: Exa, clearly.** It matches products by what they are, while the keyword engines surface pages that only mention the words.

## Task 2: Prior art on bisociation and combinatorial creativity

| | Built-in (2 searches) | Exa (category="research paper" + auto) |
|---|---|---|
| Relevance | ~14/19 | ~19/20 |
| Shared by both | Cambridge "topic-based bisociative networks", Dr Inventor, the Konstanz Koestler chapter, The Marginalian, Edge.org | same |
| Novelty | Berkeley CMR "Trisociation with AI" (2025), Imperial DS92 paper, Wikipedia *Act of Creation* | Spinneret (CHI 2020), *The Combinator* (Design Science), Bisociative literature-based discovery (Springer 2020), a computational framework for conceptual blending, the HAL "Ideas Factory" PDF, an ERIC paper on maths creativity, the Helsinki ICCC-2010 paper |
| Depth | Summary | Abstract or first section text |
| Issue | – | 6 of the 10 papers came back as `exa.ai/library/...` URLs instead of the publisher URL, so they need resolving before they are shown to users |

**Winner: Exa** for breadth and for tool-related papers. Built-in found the one fresh 2025 paper (Trisociation). Using both is best for literature work.

## Task 3: AI image/video releases in the last 30 days

| | Built-in | Exa (news category + startPublishedDate) | Firecrawl (news, past month) |
|---|---|---|---|
| Freshness | Standard mode **failed**: it returned Veo 3.1, Wan2.2 and Hailuo 2.3 (all older) plus evergreen guides. Extended mode was good: Kling 4.0 (Sep 28) and the Sora API shutdown (Sep 24) | 20/20 results dated inside the window |
| Relevance | ~3/9 per query | ~15/20 on target. Off target: EmbeddingGemma 2, Tencent Hy4 LLM |
| Novelty | Context on the Sora shutdown and the state of the market | Kling 4.0, Kandinsky 6.0 Video, Reka Rho-1, PixAI Tsubaki.3, HiDream-O1-Video, Creatify Boreal-H3, LemonSlice CWM-1, Tencent Prism, a Google long-form video post | **FLUX 3 Image**, which both other tools missed. Also noise: iPhone 18, CNET roundups |
| Calls | 2 (one in extended mode) | 2, or 1 /answer call ($0.005) that returned a cited, dated summary in 2 s |

**Winner: Exa**, because its hard date filter is reliable. Built-in standard mode is not trustworthy for "last N days"; extended mode works but costs more and is slower. No single tool was complete, and Firecrawl news caught one major release the others missed.

## Task 4: Products similar to heptabase.com

| | Built-in ("apps like Heptabase" + WebFetch of toolfinder) | Exa findSimilar | Exa search (descriptive query, category=company) |
|---|---|---|---|
| Result | Obsidian, Logseq, Anytype, Notion, Joplin, Scrintal, AFFiNE, Roam | **Failed.** The plain call returned 10 directory pages *about Heptabase*. With category=company it returned lexical look-alikes (Hexabase, Hex, Metabase, base.app); only AFFiNE was relevant. A third call excluding directory domains still returned Heptabase directory pages | Scrintal, Kinopio, OrgPad, Plok, Nodeflow, MyMap, Hootnotes, oneboard (~8/10) |
| Character | The mainstream set that users expect | – | The long tail of canvas/card tools |

**Winner: built-in for well-known alternatives, and Exa *search* (not findSimilar) for the long tail.** findSimilar on a homepage is not usable as tested.

## Overall verdict

| Dimension | Built-in | Exa |
|---|---|---|
| Relevance | Medium. Listicles and SEO pages dominate | High for entity discovery, papers and dated news |
| Novelty | Mainstream names and synthesised context | Long-tail products and papers |
| Freshness | Unreliable in standard mode | Hard date filters work |
| Depth | Titles plus a model summary; full text costs a fetch per page | Page text for 10 results in one call |
| Calls/turns | More reformulation needed | Usually 1 call per task |
| Latency | Seconds; extended mode is slower | 0.3–5 s |
| Cost | Bundled in the model or plan | ~$0.004–0.007 per call, so trivial |

## Recommendation for npkn

1. **Add Exa (yes, it is worth a key).** Expose it as an extra agent tool (`exa_search`, optionally `exa_answer`), with the agent's built-in search kept as the default for general questions.
   - **Competitor or product scans:** use Exa search with `category:"company"` and a *descriptive* query ("an app that does X"). This was the biggest gain of the test.
   - **Papers and prior art:** use Exa with `category:"research paper"`, plus one built-in search for very recent work. Resolve `exa.ai/library` URLs to the publisher URL before showing them.
   - **News / "last N days":** use Exa with `startPublishedDate` (or `/answer` for a quick cited summary). Optionally add one Firecrawl news query for coverage.
   - **Do not use `findSimilar` on homepages.** Turn the page into a descriptive query and use Exa search instead.
2. **Built-in WebSearch:** keep it for general and mainstream questions ("best-known alternatives", facts, docs), and use extended mode when freshness matters.
3. **Page reading:** keep Firecrawl scrape for any page that needs full or JS-rendered content. Exa's inline text (around 1500–3000 characters) covers skimming search results, so fewer scrapes are needed. WebFetch is fine for occasional reads but returns a lossy summary.
4. **Firecrawl /search:** a marginal addition. It is Google-like, with a lot of social and listicle noise, but its news mode with a time filter found FLUX 3, which the others missed. Since the key already exists, it can be an optional "second opinion" for news. It does not justify building anything new.
5. **Perplexity:** not needed. Exa `/answer` already gives a cited, dated synthesis for $0.005 in about 2 s, and the agent synthesises results itself. Perplexity would add cost and a third vendor without covering a gap found in these tasks.

Limits of this test: one run per tool per task, relevance was judged by hand from titles and snippets, and built-in latency was not instrumented.
