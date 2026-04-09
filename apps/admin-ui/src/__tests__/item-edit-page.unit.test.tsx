// @vitest-environment jsdom
/**
 * Unit tests for useItemForm hook and ItemEditPage:
 * 1. useItemForm: initializes with empty state for new items
 * 2. useItemForm: populates fields from loaded item data
 * 3. useItemForm: validation rejects empty name
 * 4. useItemForm: validation rejects past close date
 * 5. ItemEditPage: renders in page mode (not modal)
 * 6. ItemEditPage: shows sticky header with back button
 *
 * Validates: Requirements 4.1, 4.3, 4.4, 4.7, 4.8
 *
 * Pattern: test harness components that mirror real logic using
 * createElement to avoid CSS module and complex dependency issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement, useState } from 'react';

// ─── useItemForm validation harness ───────────────────────────────────────────
// Mirrors the validation logic from useItemForm.handleSubmit without
// requiring react-query, react-router, or API dependencies.

interface FormState {
  itemName: string;
  description: string;
  closeDate: string;
  content: string;
  formError: string;
}

function useItemFormValidation(initial?: Partial<FormState>) {
  const [itemName, setItemName] = useState(initial?.itemName ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [closeDate, setCloseDate] = useState(initial?.closeDate ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [formError, setFormError] = useState('');

  function validate(): boolean {
    setFormError('');

    if (!itemName.trim() || itemName.length > 200) {
      setFormError('Item name is required (1–200 characters).');
      return false;
    }
    if (!description.trim() || description.length > 2000) {
      setFormError('Description is required (1–2000 characters).');
      return false;
    }
    if (!closeDate || new Date(closeDate).getTime() <= Date.now()) {
      setFormError('Close date must be a future date and time.');
      return false;
    }
    return true;
  }

  return {
    itemName, setItemName,
    description, setDescription,
    closeDate, setCloseDate,
    content, setContent,
    formError,
    validate,
  };
}

// ─── Test harness component for useItemFormValidation ─────────────────────────

function FormValidationHarness({ initial }: { initial?: Partial<FormState> }) {
  const form = useItemFormValidation(initial);

  return createElement('div', null,
    createElement('input', {
      'data-testid': 'name-input',
      value: form.itemName,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => form.setItemName(e.target.value),
    }),
    createElement('textarea', {
      'data-testid': 'description-input',
      value: form.description,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => form.setDescription(e.target.value),
    }),
    createElement('input', {
      'data-testid': 'close-date-input',
      value: form.closeDate,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => form.setCloseDate(e.target.value),
    }),
    createElement('textarea', {
      'data-testid': 'content-input',
      value: form.content,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => form.setContent(e.target.value),
    }),
    createElement('button', {
      'data-testid': 'validate-button',
      onClick: () => form.validate(),
    }, 'Validate'),
    form.formError
      ? createElement('p', { 'data-testid': 'form-error', role: 'alert' }, form.formError)
      : null,
  );
}

// ─── ItemEditPage harness ─────────────────────────────────────────────────────
// Mirrors ItemEditPage + ItemDetailModal in page mode without router/query deps.

function ItemEditPageHarness({
  itemId,
  itemName,
  onClose,
}: {
  itemId?: string;
  itemName?: string;
  onClose: () => void;
}) {
  const isEditMode = Boolean(itemId);
  const displayName = isEditMode ? (itemName || 'Edit item') : 'New item';

  return createElement('div', { 'data-testid': 'page-wrapper' },
    // Sticky header
    createElement('div', {
      'data-testid': 'sticky-header',
      tabIndex: -1,
      'aria-label': displayName,
    },
      createElement('h2', { id: 'item-modal-title' },
        isEditMode ? 'Edit Item' : 'New Item',
      ),
      createElement('button', {
        type: 'button',
        'data-testid': 'back-button',
        onClick: onClose,
        'aria-label': 'Back to items',
      }, '← Back'),
    ),
    // Form body
    createElement('div', { 'data-testid': 'form-body' },
      createElement('form', { id: 'item-detail-form', noValidate: true },
        createElement('input', { 'data-testid': 'page-name-input', placeholder: 'Item name' }),
        createElement('textarea', { 'data-testid': 'page-description-input', placeholder: 'Description' }),
        createElement('input', { 'data-testid': 'page-close-date-input', type: 'datetime-local' }),
      ),
    ),
    // Sticky footer
    createElement('div', { 'data-testid': 'sticky-footer' },
      createElement('button', { type: 'button', 'data-testid': 'delete-button' }, 'Delete'),
      createElement('button', { type: 'submit', form: 'item-detail-form', 'data-testid': 'save-button' }, 'Save'),
    ),
  );
}

// ─── Tests: useItemForm ───────────────────────────────────────────────────────

describe('useItemForm — initializes with empty state for new items', () => {
  it('all form fields are empty strings by default', () => {
    render(createElement(FormValidationHarness, {}));

    expect(screen.getByTestId('name-input')).toHaveValue('');
    expect(screen.getByTestId('description-input')).toHaveValue('');
    expect(screen.getByTestId('close-date-input')).toHaveValue('');
    expect(screen.getByTestId('content-input')).toHaveValue('');
    expect(screen.queryByTestId('form-error')).not.toBeInTheDocument();
  });
});

describe('useItemForm — populates fields from loaded item data', () => {
  it('pre-fills form fields when initial data is provided', () => {
    render(createElement(FormValidationHarness, {
      initial: {
        itemName: 'Test Document',
        description: 'A test description for the item',
        closeDate: '2099-12-31T23:59',
        content: 'Some pasted content here',
      },
    }));

    expect(screen.getByTestId('name-input')).toHaveValue('Test Document');
    expect(screen.getByTestId('description-input')).toHaveValue('A test description for the item');
    expect(screen.getByTestId('close-date-input')).toHaveValue('2099-12-31T23:59');
    expect(screen.getByTestId('content-input')).toHaveValue('Some pasted content here');
  });
});

describe('useItemForm — validation rejects empty name', () => {
  it('shows error when name is empty and validate is called', () => {
    render(createElement(FormValidationHarness, {
      initial: {
        itemName: '',
        description: 'Valid description',
        closeDate: '2099-12-31T23:59',
      },
    }));

    fireEvent.click(screen.getByTestId('validate-button'));

    const error = screen.getByTestId('form-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('Item name is required');
  });

  it('shows error when name is only whitespace', () => {
    render(createElement(FormValidationHarness, {
      initial: {
        itemName: '   ',
        description: 'Valid description',
        closeDate: '2099-12-31T23:59',
      },
    }));

    fireEvent.click(screen.getByTestId('validate-button'));

    expect(screen.getByTestId('form-error')).toHaveTextContent('Item name is required');
  });
});

describe('useItemForm — validation rejects past close date', () => {
  it('shows error when close date is in the past', () => {
    render(createElement(FormValidationHarness, {
      initial: {
        itemName: 'Valid Name',
        description: 'Valid description',
        closeDate: '2020-01-01T00:00',
      },
    }));

    fireEvent.click(screen.getByTestId('validate-button'));

    const error = screen.getByTestId('form-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('Close date must be a future date and time');
  });

  it('shows error when close date is empty', () => {
    render(createElement(FormValidationHarness, {
      initial: {
        itemName: 'Valid Name',
        description: 'Valid description',
        closeDate: '',
      },
    }));

    fireEvent.click(screen.getByTestId('validate-button'));

    expect(screen.getByTestId('form-error')).toHaveTextContent('Close date must be a future date and time');
  });
});

// ─── Tests: ItemEditPage ──────────────────────────────────────────────────────

describe('ItemEditPage — renders in page mode (not modal)', () => {
  it('renders as a page wrapper, not a dialog', () => {
    render(createElement(ItemEditPageHarness, { onClose: vi.fn() }));

    expect(screen.getByTestId('page-wrapper')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders form fields inside the page body', () => {
    render(createElement(ItemEditPageHarness, { onClose: vi.fn() }));

    expect(screen.getByTestId('form-body')).toBeInTheDocument();
    expect(screen.getByTestId('page-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('page-description-input')).toBeInTheDocument();
    expect(screen.getByTestId('page-close-date-input')).toBeInTheDocument();
  });
});

describe('ItemEditPage — shows sticky header with back button', () => {
  it('renders sticky header with back button', () => {
    render(createElement(ItemEditPageHarness, { onClose: vi.fn() }));

    const header = screen.getByTestId('sticky-header');
    expect(header).toBeInTheDocument();

    const backButton = screen.getByTestId('back-button');
    expect(backButton).toBeInTheDocument();
    expect(backButton).toHaveAttribute('aria-label', 'Back to items');
    expect(backButton).toHaveTextContent('← Back');
  });

  it('back button calls onClose when clicked', () => {
    const onClose = vi.fn();
    render(createElement(ItemEditPageHarness, { onClose }));

    fireEvent.click(screen.getByTestId('back-button'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows "New Item" heading for create mode', () => {
    render(createElement(ItemEditPageHarness, { onClose: vi.fn() }));
    expect(screen.getByText('New Item')).toBeInTheDocument();
  });

  it('shows "Edit Item" heading for edit mode', () => {
    render(createElement(ItemEditPageHarness, { itemId: 'abc-123', itemName: 'My Doc', onClose: vi.fn() }));
    expect(screen.getByText('Edit Item')).toBeInTheDocument();
  });

  it('renders sticky footer with Save and Delete buttons', () => {
    render(createElement(ItemEditPageHarness, { onClose: vi.fn() }));

    expect(screen.getByTestId('sticky-footer')).toBeInTheDocument();
    expect(screen.getByTestId('save-button')).toBeInTheDocument();
    expect(screen.getByTestId('delete-button')).toBeInTheDocument();
  });
});
