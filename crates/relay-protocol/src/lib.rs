#![forbid(unsafe_code)]
#![allow(missing_debug_implementations)]
#![allow(clippy::all, clippy::pedantic)]

pub mod proto {
    connectrpc::include_generated!();
}
