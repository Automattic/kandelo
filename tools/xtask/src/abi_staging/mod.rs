pub mod builder_contract;
pub mod canonical_json;
pub mod consumer_registry;
pub mod evidence_policy;
pub mod guard_registry;
pub mod local_transport;
pub mod mini_lifecycle;
pub mod product_manifest;
pub mod product_evidence;
pub mod records;
pub mod request_derivation;
pub mod request_feed;
pub mod request_policy;
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
        [group, action, rest @ ..] if group == "evidence-definitions" => {
            match evidence_policy::run_evidence_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging evidence-definitions {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "evidence-definitions" => {
            eprintln!("xtask abi-staging: evidence-definitions requires generate or check");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "runtime-bundle" => {
            match evidence_policy::run_runtime_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging runtime-bundle {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "runtime-bundle" => {
            eprintln!("xtask abi-staging: runtime-bundle requires validate");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "product-evidence" => {
            match product_evidence::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging product-evidence {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "product-evidence" => {
            eprintln!(
                "xtask abi-staging: product-evidence requires validate-context or validate-result"
            );
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
        [group, action, rest @ ..] if group == "guard-codes" => {
            match guard_registry::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging guard-codes {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "guard-codes" => {
            eprintln!("xtask abi-staging: guard-codes requires generate or check");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "request-policy" => {
            match request_policy::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging request-policy {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "request-policy" => {
            eprintln!("xtask abi-staging: request-policy requires generate, check, or activation-mode");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "structural-report" => {
            match request_derivation::run_structural_report_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging structural-report {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "structural-report" => {
            eprintln!("xtask abi-staging: structural-report requires validate");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "request" => {
            match request_derivation::run_request_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging request {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "request" => {
            eprintln!("xtask abi-staging: request requires derive, fixture-check, select-current, plan-feed-write, or validate-feed-plan");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "records" => {
            match records::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging records {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "records" => {
            eprintln!("xtask abi-staging: records requires validate");
            ExitCode::from(2)
        }
        [group, action, rest @ ..] if group == "mini" => {
            match mini_lifecycle::run_cli(action, rest) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("xtask abi-staging mini {action}: {error}");
                    ExitCode::from(1)
                }
            }
        }
        [group, ..] if group == "mini" => {
            eprintln!("xtask abi-staging: mini requires run");
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
        "subcommands: help, products <generate|check>, registries <generate|check>, evidence-definitions <generate|check>, runtime-bundle validate, product-evidence <validate-context|validate-result>, builder <validate-inputs|validate-report|compare-report>, guard-codes <generate|check>, request-policy <generate|check|activation-mode>, structural-report validate, request <derive|fixture-check|select-current|plan-feed-write|validate-feed-plan>, records validate, mini run, requirements"
    );
}
