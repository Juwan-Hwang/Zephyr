import glob,os
from PIL import Image
n=0
for p in glob.glob('out/*.png'):
    w='web/'+os.path.basename(p)[:-4]+'.webp'
    if os.path.exists(w) and os.path.getmtime(w)>=os.path.getmtime(p): continue
    im=Image.open(p).convert('RGB'); im=im.resize((round(im.width*0.6),round(im.height*0.6)),Image.LANCZOS)
    im.save(w,'WEBP',quality=74,method=6); n+=1
print('converted',n)
