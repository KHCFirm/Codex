import sys
from pathlib import Path

from docx import Document
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from export_notes import export


def test_export_creates_docs_and_pdfs(tmp_path):
    csv_content = (
        "Project ID,Project Name,Project Type,Author Name,Note Text,Created At\n"
        "1,Case A,Workers' Compensation,Alice,Initial note,2024-01-01 10:00\n"
        "2,Case B,Other,Bob,Should be ignored,2024-01-02 11:00\n"
    )
    csv_path = tmp_path / "notes.csv"
    csv_path.write_text(csv_content)

    export(csv_path, tmp_path)

    docx_path = tmp_path / "1.docx"
    pdf_path = tmp_path / "1.pdf"
    assert docx_path.exists()
    assert pdf_path.exists()
    assert not (tmp_path / "2.docx").exists()

    doc = Document(docx_path)
    for para in doc.paragraphs:
        for run in para.runs:
            if run.text.strip():
                assert run.font.size.pt == 8

    reader = PdfReader(str(pdf_path))
    text = "".join(page.extract_text() for page in reader.pages)
    assert "Case A" in text
