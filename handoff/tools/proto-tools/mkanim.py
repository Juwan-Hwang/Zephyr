import sys,glob,json
from PIL import Image
d=sys.argv[1]; out=sys.argv[2]
fs=sorted(glob.glob(d+'/*.png')); st=json.load(open(d+'/times.json'))
keep=[];dur=[];last=None
for f,s in zip(fs,st):
    if s==last: dur[-1]+=1; continue
    keep.append(Image.open(f).convert('RGB')); dur.append(1); last=s
dur=[1100 if x>1 else 30 for x in dur]
keep[0].save(out,save_all=True,append_images=keep[1:],duration=dur,loop=0,quality=82,method=6)
print(out,len(keep),'frames',sum(dur),'ms',dur)
