import express from "express";
import cors from "cors";
import OpenAI from "openai"; // Groq is OpenAI compatible

const app = express();
app.use(cors());
app.use(express.json());

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY, // <-- CHANGED
  baseURL: "https://api.groq.com/openai/v1" // <-- THIS IS THE ONLY DIFFERENCE
});

app.get("/", (req, res) => res.send("✅ Walker Webs AI with Groq Running"));

app.post("/api/generate", async (req, res) => {
  const { prompt } = req.body;
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-70b-versatile", // <-- GROQ MODEL. Fastest
      messages: [
        { role: "system", content: "Return ONLY a complete single-file HTML document with inline Tailwind CSS. Dark theme, glassmorphism, modern." },
        { role: "user", content: `Build me this website: ${prompt}` }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });
    let html = completion.choices[0].message.content;
    html = html.replace(/```html/g, "").replace(/```/g, "").trim();
    res.json({ html });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Groq AI running on ${PORT}`));