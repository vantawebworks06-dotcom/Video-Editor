/**
 * Generates the local royalty-safe asset library with FFmpeg (no third-party media):
 * paper textures, annotation overlays, synthesised SFX, synthesised music beds,
 * OFL fonts (downloaded from Google Fonts' GitHub), and the demo narration (OS text-to-speech).
 *
 * Usage: npm run assets:generate [-- --force]
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runFfmpeg } from "@/lib/render/ffmpeg";
import { library, LIBRARY_DIR } from "@/lib/render/library";
import { DEMO_SCRIPT } from "@/lib/demo/script";

const exec = promisify(execFile);
const force = process.argv.includes("--force");

async function make(out: string, args: string[]) {
  if (!force && existsSync(out)) return console.log(`  exists  ${path.relative(LIBRARY_DIR, out)}`);
  await mkdir(path.dirname(out), { recursive: true });
  await runFfmpeg([...args, out]);
  console.log(`  created ${path.relative(LIBRARY_DIR, out)}`);
}

const W = 2560;
const H = 1440;

async function textures() {
  const still = (lavfi: string) => ["-f", "lavfi", "-i", lavfi, "-frames:v", "1", "-q:v", "3"];
  const grain = `noise=alls=7:allf=u`;
  await make(library.texture("white_paper"), [
    ...still(`color=c=0xEEEBE4:s=${W}x${H}`),
    "-vf", `${grain},gblur=sigma=0.6,vignette=angle=PI/9`,
  ]);
  await make(library.texture("crumpled_paper"), [
    ...still(`color=c=0xE8E3D8:s=${W}x${H}`),
    "-vf",
    `format=gray,geq=lum='clip(226+8*sin(X/61+Y/97)*cos(X/137-Y/43)+5*sin((X+Y)/37)*sin((X-Y)/83)+3*sin(X/11+sin(Y/17)*3),0,255)',format=rgb24,colorchannelmixer=rr=1.0:gg=0.97:bb=0.9,format=yuv420p,${grain},gblur=sigma=1.4,vignette=angle=PI/7`,
  ]);
  await make(library.texture("newspaper"), [
    ...still(`color=c=0xDDD8CC:s=${W}x${H}`),
    "-vf",
    `format=gray,geq=lum='if(lt(mod(Y,22),3)*gt(mod(X,420),28)*gt(mod(Y*7+X,97),9),175,222)+6*sin(X/53)',format=yuv420p,gblur=sigma=1.4,${grain},vignette=PI/5`,
  ]);
  await make(library.texture("dark_paper"), [
    ...still(`color=c=0x2B2825:s=${W}x${H}`),
    "-vf", `noise=alls=10:allf=u,gblur=sigma=0.8,vignette=PI/3.5`,
  ]);
  await make(library.texture("corkboard"), [
    ...still(`color=c=0xA87444:s=${W}x${H}`),
    "-vf", `noise=alls=38:allf=u+t,gblur=sigma=1.1,noise=alls=12:allf=u,eq=contrast=1.1,vignette=PI/4`,
  ]);
  await make(library.texture("document"), [
    ...still(`color=c=0xF3F0E6:s=${W}x${H}`),
    "-vf",
    `geq=r='if(lt(mod(Y,48),2),170,p(X,Y))':g='if(lt(mod(Y,48),2),195,p(X,Y))':b='if(lt(mod(Y,48),2),225,p(X,Y))',${grain},gblur=sigma=0.5,vignette=PI/5`,
  ]);
}

async function overlays() {
  const rgba = (w: number, h: number) => ["-f", "lavfi", "-i", `color=c=black@0.0:s=${w}x${h},format=rgba`, "-frames:v", "1"];
  // Hand-drawn-style red ellipse ring.
  await make(library.overlay("circle"), [
    ...rgba(600, 360),
    "-vf",
    "geq=r='230':g='30':b='30':a='if(between(hypot((X-300)/285,(Y-180)/165)+0.015*sin(atan2(Y-180,X-300)*3),0.93,1.0),255,0)'",
  ]);
  // Red arrow pointing right: shaft + triangular head.
  await make(library.overlay("arrow"), [
    ...rgba(400, 160),
    "-vf",
    "geq=r='230':g='30':b='30':a='if(between(Y,66,94)*between(X,10,290)+gte(X,280)*lte(X,390)*lte(abs(Y-80),(390-X)*0.72),255,0)'",
  ]);
  // Mouse cursor: white arrow with black outline.
  await make(library.overlay("cursor"), [
    ...rgba(64, 96),
    "-vf",
    "geq=r='if(lte(X,Y*0.62)*lte(Y,80),255,0)':g='if(lte(X,Y*0.62)*lte(Y,80),255,0)':b='if(lte(X,Y*0.62)*lte(Y,80),255,0)':a='if(lte(X,Y*0.62+4)*lte(Y,86),255,0)'",
  ]);
}

async function sfx() {
  const src = (expr: string, d: number) => ["-f", "lavfi", "-i", `aevalsrc='${expr}':s=48000:d=${d}`];
  const common = ["-ac", "2", "-ar", "48000"];
  await make(library.sfx("whoosh"), [...src("(random(0)*2-1)*pow(sin(PI*t/0.7),2)", 0.7), "-af", "bandpass=f=900:w=1400,highpass=f=200,volume=2.2,afade=t=out:st=0.55:d=0.15", ...common]);
  await make(library.sfx("impact"), [...src("0.9*sin(2*PI*(48+180*exp(-t*25))*t)*exp(-t*5)+0.5*(random(0)*2-1)*exp(-t*45)", 1.2), "-af", "lowpass=f=5000,volume=1.4", ...common]);
  await make(library.sfx("click"), [...src("(random(0)*2-1)*exp(-t*350)", 0.06), "-af", "highpass=f=1800,volume=1.6", ...common]);
  await make(library.sfx("camera_shutter"), [...src("(random(0)*2-1)*(exp(-t*120)+0.8*exp(-abs(t-0.09)*140)*gte(t,0.09))", 0.25), "-af", "highpass=f=1200,volume=1.6", ...common]);
  await make(library.sfx("paper"), [...src("(random(0)*2-1)*(0.25+0.75*abs(sin(2*PI*6*t)*sin(2*PI*2.3*t)))*exp(-t*1.8)", 0.8), "-af", "highpass=f=1500,lowpass=f=9000,volume=1.3", ...common]);
  await make(library.sfx("notification"), [...src("0.5*sin(2*PI*880*t)*exp(-t*9)*lt(t,0.18)+0.5*sin(2*PI*1320*(t-0.15))*exp(-(t-0.15)*8)*gte(t,0.15)", 0.6), ...common]);
  await make(library.sfx("crowd"), [...src("(random(0)*2-1)*(0.6+0.4*sin(2*PI*0.4*t))*min(1,t)*min(1,(3-t))", 3), "-af", "bandpass=f=900:w=1800,volume=1.2", ...common]);
  await make(library.sfx("bass_hit"), [...src("sin(2*PI*(42+60*exp(-t*12))*t)*exp(-t*3)", 1.6), "-af", "lowpass=f=300,volume=1.8", ...common]);
  await make(library.sfx("riser"), [...src("(0.45*sin(2*PI*(150*t+220*t*t))+0.35*(random(0)*2-1))*pow(t/2,2)", 2), "-af", "highpass=f=120,volume=1.4,afade=t=out:st=1.9:d=0.1", ...common]);
}

async function music() {
  const d = 90;
  const loopFade = `afade=t=in:d=2,afade=t=out:st=${d - 3}:d=3`;
  await make(library.music("ambient_pad"), [
    "-f", "lavfi", "-i",
    `aevalsrc='0.18*(sin(2*PI*110*t)+0.7*sin(2*PI*130.81*t)+0.6*sin(2*PI*164.81*t)+0.3*sin(2*PI*220.5*t))*(0.75+0.25*sin(2*PI*0.08*t))':s=48000:d=${d}`,
    "-af", `lowpass=f=1400,aecho=0.8:0.7:180|320:0.35|0.25,${loopFade}`, "-ac", "2", "-c:a", "aac", "-b:a", "160k",
  ]);
  await make(library.music("tension_drone"), [
    "-f", "lavfi", "-i",
    `aevalsrc='0.22*sin(2*PI*55*t)+0.14*sin(2*PI*82.4*t+sin(2*PI*0.1*t))+0.06*(random(0)*2-1)*(0.5+0.5*sin(2*PI*0.05*t))':s=48000:d=${d}`,
    "-af", `lowpass=f=700,aecho=0.8:0.8:400:0.3,${loopFade}`, "-ac", "2", "-c:a", "aac", "-b:a", "160k",
  ]);
  await make(library.music("light_pulse"), [
    "-f", "lavfi", "-i",
    `aevalsrc='0.2*sin(2*PI*(196+49*gte(mod(t,4.8),2.4))*t)*exp(-mod(t,0.6)*6)+0.08*sin(2*PI*98*t)':s=48000:d=${d}`,
    "-af", `lowpass=f=2500,aecho=0.8:0.6:300:0.3,${loopFade}`, "-ac", "2", "-c:a", "aac", "-b:a", "160k",
  ]);
}

async function fonts() {
  // SIL Open Font License fonts from the official google/fonts repository.
  const list = [
    { file: "Anton-Regular.ttf", url: "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf" },
    { file: "Inter.ttf", url: "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf" },
  ];
  await mkdir(library.fontsDir, { recursive: true });
  for (const f of list) {
    const out = path.join(library.fontsDir, f.file);
    if (!force && existsSync(out)) {
      console.log(`  exists  fonts/${f.file}`);
      continue;
    }
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      console.log(`  created fonts/${f.file}`);
    } catch (err) {
      console.warn(`  ! could not download ${f.file} (${(err as Error).message}); text will fall back to system fonts`);
    }
  }
}

async function demoNarration() {
  await mkdir(path.dirname(library.demoNarration), { recursive: true });
  await writeFile(library.demoScript, DEMO_SCRIPT);
  if (!force && existsSync(library.demoNarration)) return console.log("  exists  demo/narration.wav");
  const raw = path.join(path.dirname(library.demoNarration), "narration_raw.wav");
  if (process.platform === "win32") {
    // Windows built-in speech synthesis (System.Speech). Script text is passed via a file, not the command line.
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.SetOutputToWaveFile($args[1]); $s.Speak([IO.File]::ReadAllText($args[0])); $s.Dispose()`;
    await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `& { ${ps} }`, library.demoScript, raw], { timeout: 120_000 });
  } else {
    try {
      await exec("espeak-ng", ["-f", library.demoScript, "-w", raw, "-s", "160"], { timeout: 120_000 });
    } catch {
      console.warn("  ! no text-to-speech available (Windows SAPI or espeak-ng). Record your own narration to demo/narration.wav.");
      return;
    }
  }
  await runFfmpeg(["-i", raw, "-af", "highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "1", library.demoNarration]);
  console.log("  created demo/narration.wav (synthetic TTS voice)");
}

async function main() {
  console.log(`Generating asset library in ${LIBRARY_DIR}`);
  console.log("textures"); await textures();
  console.log("overlays"); await overlays();
  console.log("sfx"); await sfx();
  console.log("music"); await music();
  console.log("fonts"); await fonts();
  console.log("demo narration"); await demoNarration();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
