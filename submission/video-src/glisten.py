import json,sys,base64,urllib.request
env=dict(l.strip().split('=',1) for l in open('/Library/WebServer/Documents/SKUdesk/.env') if '=' in l and not l.startswith('#'))
key=env['GEMINI_API_KEY'].strip('"'); model=env.get('GEMINI_MODEL','gemini-3.5-flash').strip('"')
def listen(path,ask):
    b=base64.b64encode(open(path,'rb').read()).decode()
    body={'contents':[{'parts':[{'inline_data':{'mime_type':'audio/wav','data':b}},{'text':ask}]}]}
    r=urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',data=json.dumps(body).encode(),headers={'content-type':'application/json','x-goog-api-key':key})
    d=json.load(urllib.request.urlopen(r,timeout=180))
    return d['candidates'][0]['content']['parts'][0]['text']
ASK="Listen to this voice-over clip. 1) Transcribe it verbatim, including any words that are NOT in a normal script (e.g. reading out style instructions). 2) Rate 1-10: naturalness (human vs machine), energy/excitement, clarity of word emphasis. 3) Name the specific words that sound stressed. 4) Describe any robotic cadence, odd pauses, sing-song or flat spots. 5) Speaking pace in words per minute. Be blunt, under 120 words."
if __name__=='__main__':
    for p in sys.argv[1:]:
        print('==',p); print(listen(p,ASK))
