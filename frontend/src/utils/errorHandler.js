/**
 * Error Handler Utility
 * Categorizes errors, determines user-facing messages, and manages error notifications
 */

export const ERROR_CATEGORIES = {
  TRANSIENT: 'transient', // Network, timeout - can retry
  VALIDATION: 'validation', // User input errors
  CRITICAL: 'critical', // Unexpected server errors, requires investigation
  AUTH: 'auth', // Authentication/authorization errors
  NOT_FOUND: 'notFound', // Resource not found
};

export const categorizeError = (error) => {
  // Network errors
  if (!error.response) {
    return {
      category: ERROR_CATEGORIES.TRANSIENT,
      userMessage: 'Network error. Please check your connection and try again.',
      shouldNotify: false,
      isRetryable: true,
    };
  }

  const status = error.response?.status;
  const errorData = error.response?.data;

  // Timeout errors
  if (error.code === 'ECONNABORTED') {
    return {
      category: ERROR_CATEGORIES.TRANSIENT,
      userMessage: 'Request timed out. Please try again.',
      shouldNotify: false,
      isRetryable: true,
    };
  }

  // 401 - Unauthorized
  if (status === 401) {
    return {
      category: ERROR_CATEGORIES.AUTH,
      userMessage: 'Your session has expired. Please log in again.',
      shouldNotify: false,
      isRetryable: false,
    };
  }

  // 403 - Forbidden
  if (status === 403) {
    return {
      category: ERROR_CATEGORIES.AUTH,
      userMessage: 'You do not have permission to perform this action.',
      shouldNotify: false,
      isRetryable: false,
    };
  }

  // 404 - Not Found
  if (status === 404) {
    return {
      category: ERROR_CATEGORIES.NOT_FOUND,
      userMessage: errorData?.error || 'The resource you requested could not be found.',
      shouldNotify: false,
      isRetryable: false,
    };
  }

  // 400 - Bad Request (validation)
  if (status === 400) {
    return {
      category: ERROR_CATEGORIES.VALIDATION,
      userMessage: errorData?.error || 'Please check your input and try again.',
      shouldNotify: false,
      isRetryable: false,
    };
  }

  // 429 - Too Many Requests
  if (status === 429) {
    return {
      category: ERROR_CATEGORIES.TRANSIENT,
      userMessage: 'Too many requests. Please wait a moment and try again.',
      shouldNotify: false,
      isRetryable: true,
    };
  }

  // 5xx - Server errors (critical)
  if (status >= 500) {
    return {
      category: ERROR_CATEGORIES.CRITICAL,
      userMessage: 'An unexpected error occurred. Our team has been notified.',
      shouldNotify: true,
      isRetryable: true,
      originalError: errorData?.error || error.message,
    };
  }

  // Default: treat as critical
  return {
    category: ERROR_CATEGORIES.CRITICAL,
    userMessage: 'An unexpected error occurred. Our team has been notified.',
    shouldNotify: true,
    isRetryable: true,
    originalError: errorData?.error || error.message,
  };
};

export const createErrorLog = (error, context = {}) => {
  const categorization = categorizeError(error);

  return {
    timestamp: new Date().toISOString(),
    category: categorization.category,
    userMessage: categorization.userMessage,
    shouldNotify: categorization.shouldNotify,
    isRetryable: categorization.isRetryable,
    context,
    // Error details for logging
    errorDetails: {
      message: error.message,
      status: error.response?.status,
      endpoint: error.config?.url,
      method: error.config?.method?.toUpperCase(),
      originalError: categorization.originalError,
    },
    stackTrace: error.stack,
  };
};

export const shouldShowRetryButton = (errorLog) => {
  return errorLog.isRetryable &&
         [ERROR_CATEGORIES.TRANSIENT, ERROR_CATEGORIES.CRITICAL].includes(errorLog.category);
};

export const getErrorTitle = (category) => {
  const titles = {
    [ERROR_CATEGORIES.TRANSIENT]: 'Connection Error',
    [ERROR_CATEGORIES.VALIDATION]: 'Invalid Input',
    [ERROR_CATEGORIES.CRITICAL]: 'Unexpected Error',
    [ERROR_CATEGORIES.AUTH]: 'Authentication Required',
    [ERROR_CATEGORIES.NOT_FOUND]: 'Not Found',
  };
  return titles[category] || 'Error';
};
