# Use this script with husky to fail the commit if files in src aren't added.
# This is a good idea because if a commit is built with files in src that should
# have been added, then the build itself will fail. I'd rather fail BEFORE
# comitting rather than let the build start and fail in Jenkins.

# H/t https://stackoverflow.com/a/3801554
UNADDED_FILES=$( git ls-files --others --exclude-standard )

if [ ! -z "${UNADDED_FILES}" ]; then
	echo
	echo "Found uncomitted files in shared module:"
	echo "-------------"
	echo $UNADDED_FILES
	echo "-------------"
	echo "Failing commit until you add these files in 'git add' or add them to .gitignore"
	echo
	# Fail commit when used in husky
	exit 1
fi

