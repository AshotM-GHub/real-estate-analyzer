export default async function handler(req, res) {
    if (req.method !== "POST") {
          return res.status(405).json({ error: "Method not allowed" });
    }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const headers = {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05"
    };

  try {
        const body = req.body;

      // Always inject web_search tool
      const tools = [
        { type: "web_search_20250305", name: "web_search" },
              ...(body.tools || [])
            ];

      let messages = body.messages || [];
        const requestBody = {
                model: body.model || "claude-sonnet-4-20250514",
                max_tokens: body.max_tokens || 1500,
                system: body.system,
                tools,
                messages
        };

      // Agentic loop — keep going until no more tool use
      for (let i = 0; i < 8; i++) {
              const response = await fetch("https://api.anthropic.com/v1/messages", {
                        method: "POST",
                        headers,
                        body: JSON.stringify(requestBody)
              });

          const data = await response.json();

          if (!response.ok) {
                    return res.status(response.status).json(data);
          }

          const hasToolUse = data.content && data.content.some(b => b.type === "tool_use");

          if (!hasToolUse || data.stop_reason === "end_turn") {
                    return res.status(200).json(data);
          }

          // Add assistant response and tool results for next turn
          requestBody.messages = [
                    ...requestBody.messages,
            { role: "assistant", content: data.content },
            {
                        role: "user",
                        content: data.content
                          .filter(b => b.type === "tool_use")
                          .map(b => ({
                                          type: "tool_result",
                                          tool_use_id: b.id,
                                          content: JSON.stringify(b.input)
                          }))
            }
                  ];
      }

      return res.status(200).json({ error: "Max iterations reached" });

  } catch (error) {
        return res.status(500).json({ error: error.message });
  }
}
