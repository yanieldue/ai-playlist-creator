import { getErrorTitle, shouldShowRetryButton } from '../utils/errorHandler';
import '../styles/ErrorMessage.css';

const ErrorMessage = ({ errorLog, onRetry, onDismiss }) => {
  if (!errorLog) return null;

  const title = getErrorTitle(errorLog.category);
  const showRetryButton = shouldShowRetryButton(errorLog);

  return (
    <div className="error-message-container">
      <div className="error-message">
        <div className="error-header">
          <span className="error-icon">⚠️</span>
          <h3 className="error-title">{title}</h3>
        </div>

        <p className="error-text">{errorLog.userMessage}</p>

        <div className="error-actions">
          {showRetryButton && onRetry && (
            <button className="error-button retry-button" onClick={onRetry}>
              Try Again
            </button>
          )}
          <button className="error-button dismiss-button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};

export default ErrorMessage;
