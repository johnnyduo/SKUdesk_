import json,sys,subprocess,re,concurrent.futures as cf,os
from gtts import tts
from glisten import listen
VOICE=os.environ.get('V','Puck'); MODEL='gemini-2.5-pro-preview-tts'
out=sys.argv[1]; os.makedirs(out,exist_ok=True)
segs=json.load(open('script3.json'))
ONLY=os.environ.get('ONLY')
if ONLY: segs=[x for x in segs if x['id']==ONLY]
norm=lambda s:set(re.findall(r"[a-z0-9']+",s.lower()))
def one(s):
    for attempt in range(4):
        f=f"{out}/{s['id']}.wav"
        tts(s['text'].replace('SKUdesk','S K U desk').replace('skudesk dot lol','S K U desk dot lol'),VOICE,MODEL,f+'.raw.wav',s['style']+':')
        subprocess.run(['ffmpeg','-loglevel','error','-y','-i',f+'.raw.wav','-af','silenceremove=start_periods=1:start_threshold=-48dB,areverse,silenceremove=start_periods=1:start_threshold=-48dB,areverse',f])
        heard=listen(f,"Transcribe this audio verbatim. Output only the transcript.")
        a,b=norm(s['text'].replace('SKUdesk','sku desk').replace('skudesk','sku desk')),norm(heard.replace('SKU Desk','sku desk').replace('S K U desk','sku desk').replace('SKUdesk','sku desk').replace('[sigh]','').replace('[laughter]',''))
        extra=b-a; miss=a-b
        ok=len(extra)<=2 and len(miss)<=2
        dur=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f]))
        print(s['id'],'try',attempt,round(dur,1),'extra',sorted(extra)[:6],'missing',sorted(miss)[:6],'OK' if ok else 'RETRY',flush=True)
        if ok: return s['id'],dur
    return s['id'],dur
with cf.ThreadPoolExecutor(4) as ex: res=dict(ex.map(one,segs))
if not ONLY: json.dump(res,open(f'{out}/durations.json','w'))
print(sum(res.values()))
