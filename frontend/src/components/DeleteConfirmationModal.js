import React from 'react';
import '../styles/DeleteConfirmationModal.css';

const DeleteConfirmationModal = ({
  isOpen,
  playlistName,
  onConfirm,
  onCancel,
  isDeleting = false
}) => {
  if (!isOpen) return null;

  return (
    <div className="delete-confirmation-overlay">
      <div className="delete-confirmation-modal">
        <h2 className="delete-confirmation-title">Delete Playlist?</h2>
        <p className="delete-confirmation-message">
          Are you sure you want to delete <strong>"{playlistName}"</strong>? This action cannot be undone.
        </p>
        <div className="delete-confirmation-actions">
          <button
            className="delete-confirmation-cancel"
            onClick={onCancel}
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            className="delete-confirmation-confirm"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmationModal;
