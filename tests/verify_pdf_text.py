from pathlib import Path
from pypdf import PdfReader

path = Path(__file__).with_name('v039-selectable-fixture.pdf')
if not path.exists():
    raise SystemExit('fixture PDF was not generated')

reader = PdfReader(str(path))
text = '\n'.join(page.extract_text() or '' for page in reader.pages)

required = [
    'English',
    'සිංහල',
    'தமிழ்',
    '한국어',
    '😀',
    '🚀',
    '✅',
    'Clinician Flutter App',
    '│ HTTPS',
    '├── C1 Physiological',
    '├── C2 Behavioural',
    '├── C3 Clinical NLP → TC-WPN',
    '└── C4 Demographic',
    'RAGF Fusion',
    'Composite Risk',
    'Clinician App',
]

missing = [value for value in required if value not in text]
if missing:
    raise SystemExit('PDF text extraction lost selectable content: ' + repr(missing))

images = 0
for page in reader.pages:
    resources = page.get('/Resources')
    if not resources:
        continue
    resources = resources.get_object()
    xobjects = resources.get('/XObject')
    if not xobjects:
        continue
    xobjects = xobjects.get_object()
    for obj in xobjects.values():
        resolved = obj.get_object()
        if resolved.get('/Subtype') == '/Image':
            images += 1

if images:
    raise SystemExit(f'Text-only fixture unexpectedly contains {images} raster image object(s)')

print('Verified selectable multilingual text, box-drawing diagram content, and zero text raster images.')
