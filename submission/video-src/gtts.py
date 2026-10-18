import json,sys,base64,urllib.request,wave,re
key=[l.split('=',1)[1].strip().strip('"') for l in open('/Library/WebServer/Documents/SKUdesk/.env') if l.startswith('GEMINI_API_KEY=')][0]
def tts(text,voice,model,out,style='',mode='prefix'):
    body={'contents':[{'parts':[{'text':(style+'\n\n' if style and mode=='prefix' else '')+text}]}],'generationConfig':{'responseModalities':['AUDIO'],'speechConfig':{'voiceConfig':{'prebuiltVoiceConfig':{'voiceName':voice}}}}}
    if style and mode=='system': body['systemInstruction']={'parts':[{'text':style}]}
    import time
    for k in range(5):
        try:
            r=urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',data=json.dumps(body).encode(),headers={'content-type':'application/json','x-goog-api-key':key})
            d=json.load(urllib.request.urlopen(r,timeout=180)); break
        except urllib.error.HTTPError as e:
            if e.code>=500 or e.code==429: time.sleep(3+k*4); continue
            raise
    p=d['candidates'][0]['content']['parts'][0]['inlineData']
    pcm=base64.b64decode(p['data']); rate=int(re.search(r'rate=(\d+)',p['mimeType']).group(1)) if 'rate=' in p['mimeType'] else 24000
    w=wave.open(out,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm); w.close()
    return len(pcm)/2/rate
if __name__=='__main__':
    text="Watch. An iPhone 14, never checked before. The agent searches Google Shopping live, and Gemini reads every listing. Green, same phone. Red, something else."
    style="Speak like a sharp, warm founder demoing live to a room: confident, quick, genuinely excited, natural pauses, stress the key words, never sing-song or robotic."
    for model in ['gemini-3.8-flash-tts','gemini-2.5-pro-preview-tts']:
        for v in ['Puck','Zephyr','Kore']:
            try: print(model,v,round(tts(text,v,model,f'g/{model}-{v}.wav',style),1))
            except Exception as e: print(model,v,'ERR',str(e)[:150])
