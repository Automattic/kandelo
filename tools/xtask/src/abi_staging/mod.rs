pub mod builder_contract;
pub mod canonical_json;
pub mod consumer_registry;
pub mod product_manifest;
pub mod selection;

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
                    eprintln!("xtask abi-staging products {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "products" => {
            eprintln!("xtask abi-staging: products requires generate or check");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "registries" => {
            match consumer_registry::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging registries {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "registries" => {
            eprintln!("xtask abi-staging: registries requires generate or check");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "builder" => {
            match builder_contract::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging builder {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "builder" => {
            eprintln!("xtask abi-staging: builder requires validate-inputs, validate-report, or compare-report");
            ExitCode::from(2)
        }
        [subcommand, rest @ ..] if subcommand == "requirements" => {
            match selection::run_cli(rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging requirements: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [subcommand, ..] => {
            eprintln!("xtask abi-staging: unknown subcommand {subcommand:?}");
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    println!("usage: xtask abi-staging <subcommand> [args...]");
    println!(
        "subcommands: help, products <generate|check>, registries <generate|check>, builder <validate-inputs|validate-report|compare-report>, requirements"
    );
}
