// Express starter for the App Catalog. Its one dependency (express) is
// installed by the catalog with `npm install`, as the platform would for a
// standalone Node app. Listens on DATABRICKS_APP_PORT like any Databricks App.
const express = require('express');
const app = express();
const port = Number(process.env.DATABRICKS_APP_PORT || process.env.PORT || 3000);

app.use('/public', express.static(`${__dirname}/public`));
app.get('/api/time', (req, res) => res.json({ now: new Date().toISOString(), viewer: req.get('x-forwarded-preferred-username') || null, express: require('express/package.json').version }));
app.get('/about', (req, res) => res.redirect('/'));
app.get('/', (req, res) => res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Express starter</title>
<link rel="stylesheet" href="/public/style.css"></head><body><main><h1>Express starter</h1>
<p class="dim">Hello ${req.get('x-forwarded-preferred-username') || 'there'} · Node ${process.version}</p>
<p id="t" class="dim">fetching /api/time…</p><p><a href="/about">/about (redirects home)</a></p></main>
<script>fetch('/api/time').then(r=>r.json()).then(j=>{document.getElementById('t').textContent='server time '+j.now+' · express '+j.express})</script></body></html>`));
app.listen(port, () => console.log(`starter-express on ${port}`));
