{
  description = "Reverse-engineer OpenSpec specifications from existing codebases";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "openlore";
            version = "3.0.0";

            src = ./.;

            npmDepsFetcherVersion = 2;
            makeCacheWritable = true;
            npmDepsHash = "sha256-4LknIuY4oBlrLTWa21IiCWceZiPKsR6ZWtT1t9UBThY=";

            # Build TypeScript
            buildPhase = ''
              runHook preBuild
              npm run build
              runHook postBuild
            '';

            # Install the built package
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/node_modules/openlore
              cp -r dist package.json $out/lib/node_modules/openlore/

              # Copy node_modules for runtime dependencies
              cp -r node_modules $out/lib/node_modules/openlore/

              # The local tree-sitter-cli build stub is not shipped at runtime.
              find $out -xtype l -name tree-sitter-cli -delete

              # Create bin wrapper (ESM — must use import(), not require())
              mkdir -p $out/bin
              cat > $out/bin/openlore <<EOF
              #!${pkgs.nodejs}/bin/node
              import('../lib/node_modules/openlore/dist/cli/index.js');
              EOF
              # Remove leading whitespace from heredoc (including the shebang line)
              sed -i 's/^[[:space:]]*//' $out/bin/openlore
              chmod +x $out/bin/openlore

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Reverse-engineer OpenSpec specifications from existing codebases";
              homepage = "https://github.com/clay-good/openlore";
              license = licenses.mit;
              maintainers = [ ];
              mainProgram = "openlore";
              platforms = platforms.all;
            };
          };

          openlore = self.packages.${system}.default;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/openlore";
        };

        openlore = self.apps.${system}.default;
      });

      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_22
              nodePackages.npm
              nodePackages.typescript
              nodePackages.typescript-language-server
            ];

            shellHook = ''
              echo "openlore development environment"
              echo "Node.js version: $(node --version)"
              echo "npm version: $(npm --version)"
            '';
          };
        }
      );
    };
}
