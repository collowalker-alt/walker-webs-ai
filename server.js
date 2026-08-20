import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY 
});

app.get("/", (req, res) => res.send("✅ Walker Webs AI Running"));

app.post("/api/generate", async (req, res) => {
  const { prompt } = req.body;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Return ONLY a complete single-file HTML document with inline Tailwind CSS. Dark theme." },
        { role: "user", content: `Build me this website: ${prompt}` }
      ],
    });
    let html = completion.choices[0].message.content;
    html = html.replace(/```html/g, "").replace(/```/g, "").trim();
    res.json({ html });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on ${PORT}`));