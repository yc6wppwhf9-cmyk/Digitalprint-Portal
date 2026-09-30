# Digital Print Portal

Tracks a digital print job from the approved design PDF through production to dispatch.

## Workflow

1. **Designer** uploads the print PDF and ticks **Approved** or **Pre-approved**.
2. **Qty Receiving** – production sees the job and enters *Qty required*, *Qty available*
   and *Qty received* (or adds a delivery with *Received now (+)*).
   When qty received reaches qty required, the job moves to Paper Printing on its own.
3. **Paper Printing → Fusing → Rolling → Dispatch** – at each stage enter the qty done
   there and press "Mark done"; the job then moves to the next stage. The qty from every
   completed stage stays visible on the job card.
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
