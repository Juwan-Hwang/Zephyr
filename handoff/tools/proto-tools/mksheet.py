import sys
from PIL import Image
out=sys.argv[1]; H=int(sys.argv[2]); names=sys.argv[3:]
ims=[]
for n in names:
    im=Image.open(n).convert('RGB'); s=H/im.height; ims.append(im.resize((int(im.width*s),H)))
W=sum(i.width for i in ims)+24*(len(ims)-1)
c=Image.new('RGB',(W,H),(110,110,110)); x=0
for i in ims: c.paste(i,(x,0)); x+=i.width+24
c.save(out,quality=88); print(out,c.size)
