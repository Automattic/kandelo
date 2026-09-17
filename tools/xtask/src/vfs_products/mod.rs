pub mod canonical_json;
pub mod product_manifest;

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
        [group, action, rest @ ..] if group == "products" => {
            match product_manifest::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask vfs products {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "products" => {
            eprintln!("xtask vfs: products requires generate or check");
            ExitCode::from(2)
        }
        [subcommand, ..] => {
            eprintln!("xtask vfs: unknown subcommand {subcommand:?}");
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    println!("usage: xtask vfs <subcommand> [args...]");
    println!("subcommands: help, products <generate|check>");
}
