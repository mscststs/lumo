import { describe, it, expect } from 'vitest';
import {
  findActiveTrigger,
  replaceTriggerToken,
  type TriggerSpec,
} from '@/lib/input-trigger';

const SLASH: TriggerSpec = { char: '/', placement: 'input-start' };
const AT: TriggerSpec = { char: '@', placement: 'word-start' };

describe('findActiveTrigger — slash at input start', () => {
  it('opens on a bare slash', () => {
    expect(findActiveTrigger('/', 1, [SLASH])).toEqual({
      char: '/',
      query: '',
      start: 0,
      end: 1,
    });
  });

  it('captures a partial command and extends past the caret', () => {
    // caret between `n` and `e` of `/new`
    expect(findActiveTrigger('/new', 2, [SLASH])).toEqual({
      char: '/',
      query: 'new',
      start: 0,
      end: 4,
    });
  });

  it('closes once a space ends the token', () => {
    expect(findActiveTrigger('/new ', 5, [SLASH])).toBeNull();
    // Caret past the space: the token ended, even though the text continues.
    expect(findActiveTrigger('/new hello', 5, [SLASH])).toBeNull();
  });

  it('ignores a slash that is not at position 0', () => {
    expect(findActiveTrigger('see /new', 8, [SLASH])).toBeNull();
  });
});

describe('findActiveTrigger — @ at word start', () => {
  it('opens after whitespace mid-sentence', () => {
    expect(findActiveTrigger('see @fi', 7, [AT])).toEqual({
      char: '@',
      query: 'fi',
      start: 4,
      end: 7,
    });
  });

  it('opens at the very start of the value', () => {
    expect(findActiveTrigger('@file', 5, [AT])).toMatchObject({
      char: '@',
      query: 'file',
      start: 0,
    });
  });

  it('does not open inside a word', () => {
    expect(findActiveTrigger('email@x', 7, [AT])).toBeNull();
  });
});

describe('replaceTriggerToken', () => {
  it('rewrites only the active range and reports the new caret', () => {
    expect(replaceTriggerToken('/ne rest', { start: 0, end: 3 }, '/new ')).toEqual({
      value: '/new  rest',
      caret: 5,
    });
  });
});
