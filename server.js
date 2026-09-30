import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;

const { app } = createApp({
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'uploads'),
  publicDir: path.join(root, 'public'),
});

app.listen(port, () => {
  console.log(`Digital Print Portal running at http://localhost:${port}`);
});
