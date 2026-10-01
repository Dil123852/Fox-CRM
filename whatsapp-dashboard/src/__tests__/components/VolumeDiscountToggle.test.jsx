import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VolumeDiscountToggle from '../../components/VolumeDiscountToggle';
import { volumeDiscountChoice } from '../../lib/orderItems';

describe('volumeDiscountChoice', () => {
  it('ticked: the discount the cart earns, as before', () => {
    expect(volumeDiscountChoice(2, true)).toEqual({ eligible: 1500, amount: 1500, waived: false });
    expect(volumeDiscountChoice(4, true)).toEqual({ eligible: 2500, amount: 2500, waived: false });
  });

  it('unticked: nothing off, and recorded as waived', () => {
    expect(volumeDiscountChoice(2, false)).toEqual({ eligible: 1500, amount: 0, waived: true });
  });

  it('a cart that earns nothing is never "waived", ticked or not', () => {
    expect(volumeDiscountChoice(1, false)).toEqual({ eligible: 0, amount: 0, waived: false });
    expect(volumeDiscountChoice(0, true)).toEqual({ eligible: 0, amount: 0, waived: false });
  });
});

describe('VolumeDiscountToggle', () => {
  it('is not shown when there is no volume discount to give', () => {
    const { container } = render(<VolumeDiscountToggle eligible={0} mattressCount={1} applied onChange={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('is ticked by default and unticking reports false', () => {
    const onChange = vi.fn();
    render(<VolumeDiscountToggle eligible={1500} mattressCount={2} applied onChange={onChange} prefix="LKR " />);
    const box = screen.getByRole('checkbox', { name: 'Apply volume discount' });
    expect(box).toBeChecked();
    expect(screen.getByText('Volume (2 mattresses)')).toBeTruthy();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('unticked it says so and strikes the amount through', () => {
    render(<VolumeDiscountToggle eligible={2500} mattressCount={3} applied={false} onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('Volume discount not given')).toBeTruthy();
    expect(screen.getByText('-2,500').style.textDecoration).toBe('line-through');
  });
});
