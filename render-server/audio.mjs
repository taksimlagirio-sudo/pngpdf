// Ses araçları (sunucuda ffmpeg ile): dalga biçimi ve sessizlik analizi, ses seviyesini eşitleme,
// baştaki/sondaki sessizliği kırpma, MP3/M4A dışa aktarma. ffmpeg kurulu değilse kullanılamaz
// (uygulama o durumda yalnızca kayıpsız ses çıkarma sunar).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

let found = null;
export function findFfmpeg() {
    if (!found) {
        found = new Promise((resolve) => {
            const cmd = process.env.FFMPEG || 'ffmpeg';
            let child;
            try {
                child = spawn(cmd, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
            } catch (_) {
                return resolve(null);
            }
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.on('error', () => resolve(null));
            child.on('close', (code) => resolve(code === 0 ? { cmd, version: (out.match(/ffmpeg version (\S+)/) || [])[1] || '' } : null));
        });
    }
    return found;
}

function run(cmd, args, { onStderr = () => {}, stdout = null, timeoutMs = 6 * 3600 * 1000, signal } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', stdout ? 'pipe' : 'ignore', 'pipe'] });
        let err = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        if (signal) signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
        if (stdout) child.stdout.on('data', stdout);
        child.stderr.on('data', (d) => {
            const s = d.toString();
            err = (err + s).slice(-20000);
            onStderr(s);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(err);
            else reject(new Error((err.trim().split('\n').pop() || `ffmpeg ${code}`).slice(0, 300)));
        });
    });
}

const secondsOf = (hms) => {
    const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(hms || '');
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

/** Süre, kanal, dalga biçimi (en çok 120 çubuk) ve baştaki/sondaki sessizlik. */
export async function analyzeAudio(file) {
    const tool = await findFfmpeg();
    if (!tool) throw new Error('Sunucuda ffmpeg yok');
    const samples = [];
    let rest = Buffer.alloc(0);
    // 8 kHz okunur, her 80 örneğin en yükseği alınır: saniyede 100 değerlik zarf.
    let acc = 0;
    let count = 0;
    const log = await run(tool.cmd, ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1',
        '-af', 'silencedetect=noise=-45dB:d=0.6,aresample=8000', '-f', 's16le', '-'], {
        stdout: (chunk) => {
            const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
            const n = buf.length >> 1;
            for (let i = 0; i < n; i++) {
                const v = Math.abs(buf.readInt16LE(i * 2));
                if (v > acc) acc = v;
                if (++count === 80) {
                    samples.push(acc);
                    acc = 0;
                    count = 0;
                }
            }
            rest = buf.subarray(n * 2);
        }
    });
    const duration = secondsOf((log.match(/Duration: (\d+:\d+:\d+\.\d+)/) || [])[1]);
    const channels = /stereo/.test(log) ? 'stereo' : /mono/.test(log) ? 'mono' : '';
    const codec = ((log.match(/Audio: (\w+)/) || [])[1] || '').toUpperCase();
    const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    let lead = 0;
    let tail = 0;
    if (starts.length && starts[0] <= 0.1 && ends.length) lead = ends[0];
    const lastStart = starts[starts.length - 1];
    if (starts.length && (ends.length < starts.length || ends[ends.length - 1] >= duration - 0.2) && lastStart > lead) tail = Math.max(0, duration - lastStart);
    // Dalga biçimi: eşit aralıklı en yüksek değerler (0–1)
    const bars = 120;
    const per = Math.max(1, Math.floor(samples.length / bars));
    const peaks = [];
    let max = 1;
    for (let i = 0; i < samples.length; i += per) {
        let m = 0;
        for (let j = i; j < Math.min(samples.length, i + per); j++) if (samples[j] > m) m = samples[j];
        peaks.push(m);
        if (m > max) max = m;
    }
    return { duration, channels, codec, lead: Math.round(lead * 10) / 10, tail: Math.round(tail * 10) / 10, peaks: peaks.map((p) => Math.round((p / max) * 100) / 100) };
}

export function createAudioJobs({ outDir }) {
    const jobs = new Map();
    fs.mkdirSync(outDir, { recursive: true });

    return {
        async start({ file, duration = 0, normalize = false, lead = 0, tail = 0, format = 'mp3', bitrate = 192, name = 'ses' }) {
            const tool = await findFfmpeg();
            if (!tool) throw new Error('Sunucuda ffmpeg yok');
            const id = randomBytes(8).toString('hex');
            const ext = format === 'm4a' ? 'm4a' : 'mp3';
            const out = `${outDir}/${id}.${ext}`;
            const job = { id, state: 'running', progress: 0, error: '', out, ext, name, controller: new AbortController(), createdAt: Date.now() };
            jobs.set(id, job);
            const args = ['-hide_banner', '-y'];
            if (lead > 0) args.push('-ss', String(lead));
            args.push('-i', file);
            const keep = duration ? Math.max(1, duration - lead - tail) : 0;
            if (tail > 0 && keep) args.push('-t', String(keep));
            args.push('-vn');
            if (normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
            const kbps = [96, 128, 160, 192, 256, 320].includes(Number(bitrate)) ? Number(bitrate) : 192;
            if (ext === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`);
            else args.push('-c:a', 'aac', '-b:a', `${kbps}k`, '-movflags', '+faststart');
            args.push(out);
            run(tool.cmd, args, {
                signal: job.controller.signal,
                onStderr: (s) => {
                    const t = secondsOf((s.match(/time=(\d+:\d+:\d+\.\d+)/) || [])[1]);
                    if (t && keep) job.progress = Math.min(0.99, t / keep);
                }
            }).then(() => {
                job.state = 'done';
                job.progress = 1;
                job.size = fs.statSync(out).size;
            }).catch((err) => {
                job.state = 'error';
                job.error = err.message;
                fs.rm(out, { force: true }, () => {});
            });
            return this.get(id);
        },
        get(id) {
            const j = jobs.get(id);
            return j ? { id: j.id, state: j.state, progress: j.progress, error: j.error, size: j.size || 0, ext: j.ext, name: j.name } : null;
        },
        file(id) {
            const j = jobs.get(id);
            if (!j || j.state !== 'done') return null;
            return { path: j.out, name: `${j.name}.${j.ext}`, mime: j.ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4', size: j.size };
        },
        remove(id) {
            const j = jobs.get(id);
            if (!j) return false;
            j.controller.abort();
            fs.rm(j.out, { force: true }, () => {});
            jobs.delete(id);
            return true;
        }
    };
}
