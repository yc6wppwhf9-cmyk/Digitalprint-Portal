# Digital Print Portal

Tracks a digital print job from the approved design PDF through production to dispatch.

## Workflow

1. **Designer** uploads the print PDF and ticks **Approved** or **Pre-approved**.
2. **Qty Receiving** – production sees the job and enters *Qty required*, *Qty available*
   and *Qty received* (or adds a delivery with *Received now (+)*).
   When qty received reaches qty required, the job moves to Paper Printing on its own.
3. **Paper Printing → Fusing → Rolling → Dispatch** – each stage has a
   "Mark … done" button that moves the job to the next stage.
4. **Dispatched** – finished.

Every change is recorded in the job's **History**.

## Run

Requires Node.js 22.13 or later (uses the built-in `node:sqlite`).

```sh
npm install
npm start          # http://localhost:3000
npm test
```

Environment variables: `PORT` (default 3000), `DATA_DIR` (SQLite db, default `./data`),
`UPLOAD_DIR` (PDFs, default `./uploads`).
