mod manifest;
mod run;
mod tone_run;
mod wedge;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("tone") {
        if args.len() != 4 {
            eprintln!("usage: film-bench tone <wedge.json> <out_dir>");
            std::process::exit(2);
        }
        if let Err(e) = tone_run::run(&args[2], &args[3]) {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
        return;
    }
    if args.len() != 3 {
        eprintln!("usage: film-bench <manifest.json> <out_dir>   |   film-bench tone <wedge.json> <out_dir>");
        std::process::exit(2);
    }
    if let Err(e) = run::run(&args[1], &args[2]) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
