pub mod canonical_json;

use std::process::ExitCode;

pub fn run(args: Vec<String>) -> ExitCode {
    match args.as_slice() {
        [] => {
            print_help();
            ExitCode::SUCCESS
        }
        [single] if single == "help" => {
            print_help();
            ExitCode::SUCCESS
        }
        [subcommand, ..] => {
            eprintln!("xtask abi-staging: unknown subcommand {subcommand:?}");
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    println!("usage: xtask abi-staging <subcommand> [args...]");
    println!("subcommands: help");
}
