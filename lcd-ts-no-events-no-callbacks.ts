'use strict';

import { BinaryValue, Gpio } from 'onoff';
import mutexify  from 'mutexify';

const ROW_OFFSETS = [0x00, 0x40, 0x14, 0x54];

const COMMANDS = {
  CLEAR_DISPLAY: 0x01,
  HOME: 0x02,
  SET_CURSOR: 0x80,
  DISPLAY_ON: 0x04,
  DISPLAY_OFF: ~0x04,
  CURSOR_ON: 0x02,
  CURSOR_OFF: ~0x02,
  BLINK_ON: 0x01,
  BLINK_OFF: ~0x01,
  SCROLL_LEFT: 0x18,
  SCROLL_RIGHT: 0x1c,
  LEFT_TO_RIGHT: 0x02,
  RIGHT_TO_LEFT: ~0x02,
  AUTOSCROLL_ON: 0x01,
  AUTOSCROLL_OFF: ~0x01
};

const delay = (time: number) => new Promise(resolve => setTimeout(resolve, time));

const sleepus = (usDelay: number) => {
  let startTime = process.hrtime();
  let deltaTime;
  let usWaited = 0;

  while (usDelay > usWaited) {
    deltaTime = process.hrtime(startTime);
    usWaited = (deltaTime[0] * 1E9 + deltaTime[1]) / 1000;
  }
};

interface LcdConfig {
  rs: number;
  e: number;
  data: [number, number, number, number];
  cols: number;
  rows: number;
  largeFont: boolean;
  notAutomaticInit: boolean;
}

type Release = () => void;

type Lock = ReturnType<typeof mutexify>;

class Lcd {
  private readonly rs: Gpio;
  private readonly e: Gpio;
  private readonly data: [Gpio, Gpio, Gpio, Gpio];
  // @ts-ignore
  private readonly cols: number;
  private readonly rows: number;
  private readonly largeFont: boolean;
  private displayControl: number;
  private displayMode: number;
  private readonly lock: Lock;

  constructor(config: LcdConfig) {
    this.cols = config.cols || 16; // TODO - Never used, remove?
    this.rows = config.rows || 1;
    this.largeFont = !!config.largeFont;

    this.rs = new Gpio(config.rs, 'low'); // reg. select, output, initially low
    this.e = new Gpio(config.e, 'low'); // enable, output, initially low
    this.data = config.data.map(gpioNo => new Gpio(gpioNo, 'low')) as [Gpio, Gpio, Gpio, Gpio];

    this.displayControl = 0x0c; // display on, cursor off, cursor blink off
    this.displayMode = 0x06; // left to right, no shift

    this.lock = mutexify();

    if (!config.notAutomaticInit) {
      this.init();
    }
  }

  public async init(): Promise<void> {
    await delay(16);                          // wait > 15ms
    await this.write4Bits(0x03); // 1st wake up
    await delay(16);               // wait > 4.1ms
    await this.write4Bits(0x03); // 2nd wake up
    await delay(2);               // wait > 160us
    await this.write4Bits(0x03); // 3rd wake up
    await delay(2);               // wait > 160us

    let displayFunction = 0x20;

    await this.write4Bits(0x02);

    if (this.rows > 1) {
      displayFunction |= 0x08;
    }
    if (this.rows === 1 && this.largeFont) {
      displayFunction |= 0x04;
    }
    await this.command(displayFunction);

    await this.command(0x10);
    await this.command(this.displayControl);
    await this.command(this.displayMode);

    await this.command(0x01); // clear display (don't call clear to avoid event)
    await delay(3);     // wait > 1.52ms for display to clear
  }

  public print(val: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.lock(async (release: Release) => {
        const str = `${val}`;

        // If n*80+m characters should be printed, where n>1, m<80, don't
        // display the first (n-1)*80 characters as they will be overwritten.
        // For example, if asked to print 802 characters, don't display the
        // first 720.
        const displayFills = Math.floor(str.length / 80);
        const index = displayFills > 1 ? (displayFills - 1) * 80 : 0;

        try {
          await this.printChar(str, index, release);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  private printChar(str: string, index: number, release: Release): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      setImmediate(async () => {
        if (index >= str.length) {
          release();
          resolve();
          return;
        }

        try {
          await this.write(str.charCodeAt(index));
          await this.printChar(str, index + 1, release);
          resolve();
        } catch (err) {
          release();
          reject(err);
        }
      });
    });
  }

  public async clear(): Promise<void> {
    // Wait > 1.52ms. There were issues waiting for 2ms so wait 3ms.
    return this.commandAndDelay(COMMANDS.CLEAR_DISPLAY, 3);
  }

  public home(): Promise<void> {
    // Wait > 1.52ms. There were issues waiting for 2ms so wait 3ms.
    return this.commandAndDelay(COMMANDS.HOME, 3);
  }

  public async setCursor(col: number, row: number): Promise<void> {
    const r = row > this.rows ? this.rows - 1 : row;
    // TODO: throw error instead? Seems like this could cause a silent bug.
    // we don't check for column because scrolling is a possibility. Should
    // we check if it's in range if scrolling is off?
    await this.command(COMMANDS.SET_CURSOR | (col + ROW_OFFSETS[r]));
  }

  public async display(): Promise<void> {
    this.displayControl |= COMMANDS.DISPLAY_ON;
    await this.command(this.displayControl);
  }

  public async noDisplay(): Promise<void> {
    this.displayControl &= COMMANDS.DISPLAY_OFF;
    await this.command(this.displayControl);
  }

  public async cursor(): Promise<void> {
    this.displayControl |= COMMANDS.CURSOR_ON;
    await this.command(this.displayControl);
  }

  public async noCursor(): Promise<void> {
    this.displayControl &= COMMANDS.CURSOR_OFF;
    await this.command(this.displayControl);
  }

  public async blink(): Promise<void> {
    this.displayControl |= COMMANDS.BLINK_ON;
    await this.command(this.displayControl);
  }

  public async noBlink(): Promise<void> {
    this.displayControl &= COMMANDS.BLINK_OFF;
    await this.command(this.displayControl);
  }

  public async scrollDisplayLeft(): Promise<void> {
    await this.command(COMMANDS.SCROLL_LEFT);
  }

  public async scrollDisplayRight(): Promise<void> {
    await this.command(COMMANDS.SCROLL_RIGHT);
  }

  public async leftToRight(): Promise<void> {
    this.displayMode |= COMMANDS.LEFT_TO_RIGHT;
    await this.command(this.displayMode);
  }

  public async rightToLeft(): Promise<void> {
    this.displayMode &= COMMANDS.RIGHT_TO_LEFT;
    await this.command(this.displayMode);
  }

  public async autoscroll(): Promise<void> {
    this.displayMode |= COMMANDS.AUTOSCROLL_ON;
    await this.command(this.displayMode);
  }

  public async noAutoscroll(): Promise<void> {
    this.displayMode &= COMMANDS.AUTOSCROLL_OFF;
    await this.command(this.displayMode);
  }

  public close(): void {
    this.rs.unexport();
    this.e.unexport();
    this.data.forEach(gpio => gpio.unexport());
  }

  private commandAndDelay(command: number, timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.lock(async (release) => {
        try {
          await this.command(command);
          await delay(timeout);
          resolve();
        } catch (err) {
          reject(err);
        }
        release();
      });
    });
  }

  private async command(cmd: number): Promise<void> {
    // Maximum execution time
    // HD44780                | 37us
    // ST7066U                | 37us
    // NHD-0420DZ-FL-YBW-33V3 | 39us
    await this.send(cmd, 0);
    sleepus(39);
  }

  private async write(val: number): Promise<void> {
    // Maximum execution time
    // HD44780                | 37us
    // ST7066U                | 37us
    // NHD-0420DZ-FL-YBW-33V3 | 43us
    await this.send(val, 1);
    sleepus(43);
  }

  private async send(val: number, mode: BinaryValue): Promise<void> {
    this.rs.writeSync(mode);
    await this.write4Bits(val >> 4);
    await this.write4Bits(val);
  }

  private async write4Bits(val: number | any): Promise<void> {
    if (typeof val !== 'number') {
      throw new Error('Value passed to .write4Bits must be a number');
    }

    //                                         | HD44780 | ST7066U | Unit |
    // Minium enable cycle time                |    1000 |    1200 |   ns |
    // Minimum enable pulse width (high level) |     450 |     460 |   ns |
    await this.e.write(1);
    await Promise.all(this.data.map((gpio, i) => gpio.write(((val >> i) & 1) as BinaryValue)));
    await this.e.write(0);
    sleepus(1);
  }
}

module.exports = Lcd;
