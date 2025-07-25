import { useRef, useState } from 'react'
import { parseFile } from '../parser'
import type { ParseResult } from '../parser'

export default function UploadArea() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [results, setResults] = useState<ParseResult[]>([])
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)

  async function handleFiles(files: FileList | null) {
    if (!files) return
    setProcessing(true)
    setResults([])
    const out: ParseResult[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setProgress((i / files.length) * 100)
      const result = await parseFile(file)
      out.push(result)
    }
    setProgress(100)
    setResults(out)
    setProcessing(false)
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="border-2 border-dashed rounded-lg p-10 text-center cursor-pointer bg-white shadow-sm"
        onClick={() => inputRef.current?.click()}
      >
        <p className="text-gray-700">Drag & drop PDF files here, or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {processing && (
        <div className="mt-4 w-full bg-gray-200 rounded-full h-2.5">
          <div className="bg-blue-500 h-2.5 rounded-full" style={{ width: `${progress}%` }} />
        </div>
      )}
      {results.length > 0 && (
        <div className="mt-6 space-y-4">
          <button
            className="px-4 py-2 bg-blue-600 text-white rounded"
            onClick={() => {
              const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = 'parsed_results.json'
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            Download JSON
          </button>
          {results.map((r, idx) => (
            <details key={idx} className="border rounded bg-white p-4 shadow-sm">
              <summary className="cursor-pointer font-semibold">
                {r.source_file} ({r.doc_type})
              </summary>
              <pre className="mt-2 whitespace-pre-wrap text-sm">
                {JSON.stringify(r, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
