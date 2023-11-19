import { MidiBuffer, TuneObject, renderAbc, synth } from 'abcjs';
import { MarkdownRenderChild } from 'obsidian';
import { AUDIO_PARAMS, DEFAULT_OPTIONS, OPTIONS_REGEX, PLAYBACK_CONTROLS_ID, SYNTH_INIT_OPTIONS } from './cfg';
import { NoteHighlighter, togglePlayingHighlight } from './note_highlighter';

const presets = new Map([
  ["drums", `L: 1/8
Q:1/4=80
m: ç = "<("">)"c
%%stretchlast 1
%%percmap D  pedal-hi-hat x
%%percmap F  bass-drum-1
%%percmap E  acoustic-bass-drum
%%percmap G  low-floor-tom
%%percmap A  high-floor-tom
%%percmap B  low-tom
%%percmap ^B tambourine   triangle
%%percmap c  acoustic-snare
%%percmap _c electric-snare
%%percmap ^c low-wood-block   triangle
%%percmap =c side-stick x
%%percmap d  low-tom
%%percmap =d  low-mid-tom harmonic
%%percmap ^d hi-wood-block    triangle
%%percmap e  hi-mid-tom
%%percmap ^e cowbell      triangle
%%percmap f  high-tom
%%percmap ^f ride-cymbal-1
%%percmap =f ride-bell harmonic
%%percmap g  closed-hi-hat x
%%percmap ^g open-hi-hat x
%%percmap _g pedal-hi-hat x
%%percmap a  crash-cymbal-1  x
%%percmap ^a open-triangle triangle
K:C perc
U: o = !open!
U: p = !+!
%%staves (hands feet)`]
]);

/**
 * This class abstraction is needed to support load/unload hooks
 * 
 * "If your post processor requires lifecycle management, for example, to clear an interval, kill a subprocess, etc when this element is removed from the app..."
 * https://marcus.se.net/obsidian-plugin-docs/reference/typescript/interfaces/MarkdownPostProcessorContext#addchild
 */
export class PlaybackElement extends MarkdownRenderChild {
  private readonly abortController = new AbortController();
  private readonly midiBuffer: MidiBuffer = new synth.CreateSynth();
  private readonly synthCtrl = new synth.SynthController();

  constructor(
    private readonly el: HTMLElement,
    private readonly markdownSource: string,
  ) {
    super(el); // important
  }

  onload() {
    const { userOptions, source } = this.parseOptionsAndSource();
    const processedSource = this.processCustomDirectives(source);
    const renderResp = renderAbc(this.el, processedSource, Object.assign(DEFAULT_OPTIONS, userOptions));
    this.enableAudioPlayback(renderResp[0]);
  }

  /**
   * Stop the music and clean things up.
   * 
   * (Tested) Called when:
   * 1. Cursor focus goes into the text area (which switches from preview to edit mode)
   * 2. A tab containing this is closed (very important)
   * 
   * Not called when:
   * 1. Switching tabs to a different one (audio keeps playing)
   */
  onunload() {
    this.abortController.abort(); // dom event listeners

    // A lot of steps, but I think all these things need to happen to really stop in-progress audio playback for ABCjs.
    this.synthCtrl.restart();
    this.synthCtrl.pause();
    this.midiBuffer.stop(); // doesn't stop the music by itself?
  }

  parseOptionsAndSource(): { userOptions: {}, source: string } {
    let userOptions = {};

    const optionsMatch = this.markdownSource.match(OPTIONS_REGEX);
    let source = this.markdownSource; // can be modified, removes the options portion.
    if (optionsMatch !== null) {
      source = optionsMatch.groups["source"];
      try {
        userOptions = JSON.parse(optionsMatch.groups["options"]);
      } catch (e) {
        console.error(e);
        this.renderError(`<strong>Failed to parse user-options</strong>\n\t${e}`);
      }
    }

    return { userOptions, source };
  }

  processCustomDirectives(source: string) {
    source = source.replace(/^%%preset\s+(\w+)\s*$/gm, (directive, filename) => {
      return presets.get(filename) || directive;
    });

    // gather macros
    const macros = [...source.matchAll(/^m:\s*(?<name>.*(?=\s))\s*=\s*(?<expansion>.*?)\s*$/gm)]
        .reduce((map, match) => {
          map.set(match.groups.name, match.groups.expansion);
          return map;
        }, new Map<string, string>());

    console.log("macros", macros);

    const lines = source.split(/\n/);

    // expand macros
    macros.forEach((expansion, macro) => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/^(\w:|%)/)) {
          continue;
        }
        console.log(`replacing ${macro} in ${line} (expansion=${expansion}`);

        const newLine = line.replaceAll(macro, expansion);

        if (newLine !== line) {
          console.log('new value:', newLine)
        }

        lines[i] = newLine;
      }

      console.log(`source after replacing ${macro}`, lines.join("\n"));
    })

    return lines.join("\n");
  }

  renderError(error?: string) {
    if (error == null) return;
    const errorNode = document.createElement('div');
    errorNode.innerHTML = error;
    errorNode.addClass("obsidian-plugin-abcjs-error");
    this.el.appendChild(errorNode);
  }

  // Audio playback features
  // Many variants, options, and guidance here: https://paulrosen.github.io/abcjs/audio/synthesized-sound.html
  enableAudioPlayback(visualObj: TuneObject) {
    if (!synth.supportsAudio()) return;

    // We need the SynthController to drive NoteHighlighter (CursorControl), even though we don't want the UI controls from SynthController
    this.synthCtrl.load(
      `#${PLAYBACK_CONTROLS_ID}`, //controlsEl, // can be an HTMLElement reference or css selector
      new NoteHighlighter(this.el), // an implementation of a `CursorControl`
    );

    this.midiBuffer.init({ visualObj, options: SYNTH_INIT_OPTIONS })
      .then(() => this.synthCtrl.setTune(visualObj, false, AUDIO_PARAMS))
      .catch(console.warn.bind(console));

    const signal = this.abortController.signal; // for event cleanup
    this.el.addEventListener('click', this.togglePlayback, { signal });
    this.el.addEventListener('dblclick', this.restartPlayback, { signal });
  }

  private readonly togglePlayback = () => {
    // private access. Can improve when https://github.com/paulrosen/abcjs/pull/917 merges
    const isPlaying = (this.midiBuffer as any)?.isRunning;
    isPlaying ? this.synthCtrl.pause() : this.synthCtrl.play();
    togglePlayingHighlight(this.el)(isPlaying);
  };

  // start again at the begining of the tune
  private readonly restartPlayback = () => {
    this.synthCtrl.restart();
  };
}


