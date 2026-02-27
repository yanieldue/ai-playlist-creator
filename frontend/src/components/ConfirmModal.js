import React from 'react';
import '../styles/DeleteConfirmationModal.css';

const ConfirmModal = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div className="delete-confirmation-overlay" onClick={onCancel}>
      <div className="delete-confirmation-modal confirm-modal" onClick={e => e.stopPropagation()}>
        <h2 className="delete-confirmation-title">{title}</h2>
        <p className="delete-confirmation-message">{message}</p>
        <div className="delete-confirmation-actions">
          <button className="delete-confirmation-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="confirm-modal-confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
