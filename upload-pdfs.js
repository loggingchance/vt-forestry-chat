import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Your actual PDF folder (exact path you gave me)
const PDF_FOLDER = "C:/Users/steve/Dropbox/Technical Items/vt-forestry-chat/vt-forestry-pdfs";

// ✅ Reuse the vector store you already created
const VECTOR_STORE_ID = "vs_69514a7346f48191b3bfd2da3ac2dd7d";

async function main() {
  // 1) Verify folder exists
  if (!fs.existsSync(PDF_FOLDER)) {
    console.error("PDF folder not found:", PDF_FOLDER);
    console.error("Fix PDF_FOLDER to the correct path and try again.");
    process.exit(1);
  }

  // 2) Find PDFs
  const pdfFiles = fs
    .readdirSync(PDF_FOLDER)
    .filter((f) => f.toLowerCase().endsWith(".pdf"));

  if (pdfFiles.length === 0) {
    console.error("No PDF files found in:", PDF_FOLDER);
    console.error("Put one or more PDFs in that folder and try again.");
    process.exit(1);
  }

  console.log("Using vector store:", VECTOR_STORE_ID);
  console.log("PDF folder:", PDF_FOLDER);
  console.log("PDFs found:", pdfFiles.length);

  // 3) Upload + attach each PDF to the vector store
  for (const filename of pdfFiles) {
    const fullPath = path.join(PDF_FOLDER, filename);

    console.log("\nUploading:", filename);

    const uploaded = await client.files.create({
      file: fs.createReadStream(fullPath),
      purpose: "assistants",
    });

    await client.vectorStores.files.create(VECTOR_STORE_ID, {
      file_id: uploaded.id,
    });

    console.log("Attached to vector store:", filename);
  }

  console.log("\nDone. All PDFs uploaded and attached.");
}

main().catch((err) => {
  console.error("Upload failed:");
  console.error(err?.message || err);
  process.exit(1);
});
