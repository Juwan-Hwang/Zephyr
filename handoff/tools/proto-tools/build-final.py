import os
WORK = os.environ.get("WORK", ".")
import re, base64
s = open(WORK + '/proto-tools/page-final-src.html').read()
def sub(m):
    b = base64.b64encode(open(f'{WORK}/proto-tools/web/{m.group(1)}.webp', 'rb').read()).decode()
    return f'src="data:image/webp;base64,{b}"'
out = re.sub(r'src="@([A-Za-z0-9-]+)"', sub, s)
open(WORK + '/zephyr-ui-final.html', 'w').write(out)
print(len(re.findall(r'src="@', s)), len(out) // 1024, 'KB')
