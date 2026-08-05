/**
 * @vitest-environment jsdom
 *
 * Behavioural cover for the Dialog primitive.
 *
 * `DialogContent` renders a full-screen flex wrapper *above* the overlay in
 * order to centre the panel. That wrapper is the risky part: if it captured
 * pointer events it would intercept every click meant for the backdrop, and
 * click-outside dismissal — which the whole options page relies on — would
 * silently stop working while still looking correct. `pointer-events-none` on
 * the wrapper is asserted in `dialog-animation.test.ts` as a class; here the
 * actual dismissal behaviour is exercised.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

afterEach(cleanup);

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Provider</DialogTitle>
        </DialogHeader>
        <input aria-label="name" />
      </DialogContent>
    </Dialog>,
  );
  return onOpenChange;
}

describe('Dialog', () => {
  it('renders its content with dialog semantics', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Add Provider')).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onOpenChange = renderDialog();

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
      code: 'Escape',
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes via the built-in close button', () => {
    const onOpenChange = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not close when interacting with the panel itself', () => {
    const onOpenChange = renderDialog();

    const input = screen.getByLabelText('name');
    fireEvent.pointerDown(input);
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'Acme' } });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves the centring wrapper transparent to pointer events', () => {
    renderDialog();
    const panel = screen.getByRole('dialog');
    const wrapper = panel.parentElement!;

    // The wrapper spans the viewport in front of the overlay, so it must not
    // absorb clicks; the panel opts back in for its own controls.
    expect(wrapper.className).toContain('pointer-events-none');
    expect(panel.className).toContain('pointer-events-auto');
  });

  it('centres the panel through the wrapper rather than transforms', () => {
    renderDialog();
    const wrapper = screen.getByRole('dialog').parentElement!;

    expect(wrapper.className).toContain('items-center');
    expect(wrapper.className).toContain('justify-center');
    // Were the panel still positioned with translate utilities, the enter
    // keyframe would compose with them and park it off-centre.
    expect(screen.getByRole('dialog').className).not.toContain('-translate-');
  });

  it('omits the close button when asked', () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>No close</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
