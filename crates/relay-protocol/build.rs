fn main() {
    if let Err(error) = connectrpc_build::Config::new()
        .files(&[
            "../../proto/pocket/omp/relay/v1/relay.proto",
            "../../proto/pocket/omp/internal/v1/internal.proto",
        ])
        .includes(&["../../proto"])
        .include_file("_connectrpc.rs")
        .generate_json(false)
        .compile()
    {
        panic!("relay protobuf generation failed: {error}");
    }
}
