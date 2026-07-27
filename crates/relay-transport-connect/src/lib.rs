#![forbid(unsafe_code)]

use relay_application::ApplicationError;
use relay_domain::DomainError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectCode {
    InvalidArgument,
    PermissionDenied,
    ResourceExhausted,
    AlreadyExists,
    Aborted,
    Unavailable,
    Internal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ErrorDetail {
    pub code: ConnectCode,
    pub detail_code: &'static str,
}

#[must_use]
pub const fn map_application_error(error: &ApplicationError) -> ErrorDetail {
    match error {
        ApplicationError::Domain(DomainError::SenderMismatch | DomainError::RouteNotGranted) => {
            ErrorDetail {
                code: ConnectCode::PermissionDenied,
                detail_code: "ROUTE_NOT_GRANTED",
            }
        }
        ApplicationError::Domain(DomainError::WrongRegion | DomainError::StaleRouteEpoch) => {
            ErrorDetail {
                code: ConnectCode::Aborted,
                detail_code: "ROUTE_EPOCH_MISMATCH",
            }
        }
        ApplicationError::Domain(DomainError::BatchSize) => ErrorDetail {
            code: ConnectCode::InvalidArgument,
            detail_code: "BATCH_TOO_LARGE",
        },
        ApplicationError::Domain(DomainError::EnvelopeSize) => ErrorDetail {
            code: ConnectCode::InvalidArgument,
            detail_code: "FRAME_TOO_LARGE",
        },
        ApplicationError::Domain(
            DomainError::InvalidExpiry
            | DomainError::InvalidNonce
            | DomainError::InvalidRoute
            | DomainError::InvalidIdentifier(_)
            | DomainError::SequenceExhausted,
        )
        | ApplicationError::InvalidReadLimit
        | ApplicationError::InvalidSnapshot => ErrorDetail {
            code: ConnectCode::InvalidArgument,
            detail_code: "INVALID_ARGUMENT",
        },
        ApplicationError::Domain(DomainError::IdempotencyConflict) => ErrorDetail {
            code: ConnectCode::AlreadyExists,
            detail_code: "IDEMPOTENCY_CONFLICT",
        },
        ApplicationError::Domain(DomainError::EntitlementRequired) => ErrorDetail {
            code: ConnectCode::PermissionDenied,
            detail_code: "ENTITLEMENT_REQUIRED",
        },
        ApplicationError::Domain(DomainError::AckRegression) | ApplicationError::AckRegression => {
            ErrorDetail {
                code: ConnectCode::Aborted,
                detail_code: "CONCURRENT_CURSOR_UPDATE",
            }
        }
        ApplicationError::Domain(DomainError::AckBeyondIssued)
        | ApplicationError::AckBeyondIssued => ErrorDetail {
            code: ConnectCode::InvalidArgument,
            detail_code: "ACK_BEYOND_ISSUED",
        },
        ApplicationError::Repository(_) | ApplicationError::Replication(_) => ErrorDetail {
            code: ConnectCode::Unavailable,
            detail_code: "TRANSIENT_STORAGE_FAILURE",
        },
    }
}
