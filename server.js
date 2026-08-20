const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();

app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static('public'));

// AI GENERATE ROUTE
app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;
  // Replace with your real AI
  const html = `<!DOCTYPE html><html><head><title>${prompt}</title><style>body{margin:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}</style></head><body><h1 style="font-size:4rem">${prompt}</h1></body></html>`;
  res.json({html});
});

// PUBLISH ROUTE - DEPLOYS TO walker.web.app
app.post('/api/publish', async (req, res) => {
  const { projectId, html } = req.body;

  try {
    const path = `./public/p/${projectId}`;
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(`${path}/index.html`, html);

    exec(`firebase deploy --only hosting --project walker --force`, (err) => {
      if(err) return res.status(500).json({error: err.message});
      res.json({url: `https://walker.web.app/p/${projectId}`});
    });

  } catch(e) {
    res.status(500).json({error: e.message})
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Running on ${port}`));