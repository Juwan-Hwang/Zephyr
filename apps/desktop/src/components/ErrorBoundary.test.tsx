import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// Helper component that throws an error when instructed
const ProblemChild = ({ shouldThrow, errorMessage }: { shouldThrow: boolean; errorMessage?: string }) => {
  if (shouldThrow) {
    throw new Error(errorMessage || 'Child component error');
  }
  return <div>Child content rendered successfully</div>;
};

describe('ErrorBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress console.error output from React when catching errors in tests
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Child content rendered successfully')).toBeDefined();
  });

  it('updates state via getDerivedStateFromError and displays default error UI when child throws', () => {
    // Verify static getDerivedStateFromError directly
    const testError = new Error('Test error for getDerivedStateFromError');
    const derivedState = ErrorBoundary.getDerivedStateFromError(testError);
    expect(derivedState).toEqual({
      hasError: true,
      error: testError,
    });

    // Verify component behavior when child throws
    const { container } = render(
      <ErrorBoundary>
        <ProblemChild shouldThrow={true} errorMessage="Something broke!" />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(screen.getByText('Something broke!')).toBeDefined();
    expect(container.textContent).not.toContain('Child content rendered successfully');
  });

  it('calls onError callback when componentDidCatch is triggered', () => {
    const onErrorMock = vi.fn();

    render(
      <ErrorBoundary onError={onErrorMock}>
        <ProblemChild shouldThrow={true} errorMessage="Error for onError" />
      </ErrorBoundary>
    );

    expect(onErrorMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onErrorMock.mock.calls[0][0].message).toBe('Error for onError');
    expect(onErrorMock.mock.calls[0][1]).toHaveProperty('componentStack');
  });

  it('renders custom ReactNode fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom Error Fallback UI</div>}>
        <ProblemChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('custom-fallback')).toBeDefined();
    expect(screen.getByText('Custom Error Fallback UI')).toBeDefined();
  });

  it('renders function fallback with error parameter when fallback is a function', () => {
    render(
      <ErrorBoundary
        fallback={(error) => <div data-testid="function-fallback">Function fallback: {error.message}</div>}
      >
        <ProblemChild shouldThrow={true} errorMessage="Passed to function fallback" />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('function-fallback')).toBeDefined();
    expect(screen.getByText('Function fallback: Passed to function fallback')).toBeDefined();
  });
});
