// ur/gd pulse — RenderPages Lambda (container-based)
// Async invocation from ExtractText Lambda.
// Renders PDF/DOCX pages as PNG images and stores them in S3.
// DOCX files are converted to PDF via LibreOffice headless before rendering.
// Page count is governed by maxDocumentPages feature flag passed in the event.

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { execSync } from 'child_process'
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REGION = process.env.AWS_REGION || 'us-west-2'
const dynamo = new DynamoDBClient({ region: REGION })
const s3 = new S3Client({ region: REGION })

function log(level, message, context = {}) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...context }
  if (level === 'error') console.error(JSON.stringify(entry))
  else if (level === 'warn') console.warn(JSON.stringify(entry))
  else console.log(JSON.stringify(entry))
}

async function getS3Bytes(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function putS3Object(bucket, key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
}

export const handler = async (event) => {
  const { tenantId, itemId, key, bucket, maxDocumentPages } = event
  if (!tenantId || !itemId || !key || !bucket) {
    log('error', 'RenderPages: missing required event fields', { event })
    return
  }

  const limit = maxDocumentPages || 20
  log('info', 'RenderPages: starting', { tenantId, itemId, key, maxDocumentPages: limit })
  const startTime = Date.now()

  try {
    // 1. Read document from S3
    const docBytes = await getS3Bytes(bucket, key)
    const ext = key.split('.').pop()?.toLowerCase()
    log('info', 'RenderPages: document read from S3', { tenantId, itemId, sizeBytes: docBytes.length, ext, elapsed: Date.now() - startTime })

    // 2. Prepare working directory
    const workDir = join(tmpdir(), `renderPages-${itemId}-${Date.now()}`)
    mkdirSync(workDir, { recursive: true })

    let pdfPath
    if (ext === 'docx') {
      // 3a. DOCX → PDF via LibreOffice headless
      const docxPath = join(workDir, `document.docx`)
      writeFileSync(docxPath, docBytes)
      log('info', 'RenderPages: converting DOCX to PDF', { tenantId, itemId, elapsed: Date.now() - startTime })

      try {
        execSync(`libreoffice --headless --convert-to pdf --outdir "${workDir}" "${docxPath}"`, {
          timeout: 120000,
          stdio: 'pipe',
        })
      } catch (convErr) {
        log('error', 'RenderPages: LibreOffice conversion failed', { tenantId, itemId, errorMessage: convErr.message })
        return
      }

      pdfPath = join(workDir, 'document.pdf')
      if (!existsSync(pdfPath)) {
        log('error', 'RenderPages: PDF output not found after conversion', { tenantId, itemId })
        return
      }
      log('info', 'RenderPages: DOCX converted to PDF', { tenantId, itemId, elapsed: Date.now() - startTime })
    } else {
      // 3b. Already a PDF
      pdfPath = join(workDir, 'document.pdf')
      writeFileSync(pdfPath, docBytes)
    }

    // 4. Render pages using pdf-to-img
    const { pdf } = await import('pdf-to-img')
    const pdfDocument = await pdf(pdfPath, { scale: 2.0 })

    // Determine total page count
    const totalPages = pdfDocument.length
    log('info', 'RenderPages: page count determined', { tenantId, itemId, totalPages, limit, elapsed: Date.now() - startTime })

    // 5. Page limit check
    if (totalPages > limit) {
      log('warn', 'RenderPages: page count exceeds limit', { tenantId, itemId, totalPages, limit })
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        UpdateExpression: 'SET renderStatus = :status, pageCountActual = :actual',
        ExpressionAttributeValues: {
          ':status': { S: 'page_limit_exceeded' },
          ':actual': { N: String(totalPages) },
        },
      }))
      log('info', 'RenderPages: wrote page_limit_exceeded to item record', { tenantId, itemId, totalPages, limit })
      return
    }

    // 6. Render each page sequentially — one at a time, upload, release buffer
    let renderedCount = 0
    let pageNum = 0
    for await (const pageImage of pdfDocument) {
      pageNum++
      const pageKey = `pulse/${tenantId}/items/${itemId}/pages/page-${String(pageNum).padStart(3, '0')}.png`

      try {
        await putS3Object(bucket, pageKey, pageImage, 'image/png')
        renderedCount++
        log('info', 'RenderPages: page rendered and uploaded', { tenantId, itemId, page: pageNum, elapsed: Date.now() - startTime })
      } catch (uploadErr) {
        log('warn', 'RenderPages: failed to upload page, skipping', { tenantId, itemId, page: pageNum, errorName: uploadErr.name })
      }
    }

    // 7. Write pageCount to item record
    if (renderedCount > 0) {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        UpdateExpression: 'SET pageCount = :pc',
        ExpressionAttributeValues: {
          ':pc': { N: String(renderedCount) },
        },
      }))
    }

    const totalElapsed = Date.now() - startTime
    log('info', 'RenderPages: complete', { tenantId, itemId, renderedCount, totalPages, totalElapsed })

    // 8. Cleanup temp files
    try {
      unlinkSync(pdfPath)
      if (ext === 'docx') {
        const docxPath = join(workDir, 'document.docx')
        if (existsSync(docxPath)) unlinkSync(docxPath)
      }
    } catch {
      // Non-fatal — Lambda container is ephemeral
    }
  } catch (err) {
    log('error', 'RenderPages: failed', { tenantId, itemId, errorName: err.name, errorMessage: err.message })
  }
}
