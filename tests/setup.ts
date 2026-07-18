import { isInaccessible } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> {
    toBeVisible(): T;
  }
}

expect.extend({
  toBeVisible(received: unknown) {
    const pass = received instanceof Element && !isInaccessible(received);

    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to be visible`,
    };
  },
});

afterEach(() => {
  cleanup();
});
